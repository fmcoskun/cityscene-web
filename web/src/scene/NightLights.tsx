import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { assetUrl } from "../data/loadData";
import type { LightData, SceneData } from "../data/types";
import { toWorld } from "../lib/coords";
import { nearestIndices } from "../lib/nearest";
import { useApp } from "../store";
import { LIGHT_MODES } from "./lightModes";
import { groundPool, LIGHT_RADIUS_M, localLights, poolTexture, type GroundPool, type PoolShape } from "./lightPools";

/** Real lights that follow the camera: the nearest point lights and the nearest spot (and area) lights. */
const POOL_POINTS = 6;
const POOL_SPOTS = 6;
export const REAL_LIGHTS = POOL_POINTS + POOL_SPOTS;
/**
 * Multiplier on the exported intensity. The exporter now writes Blender's own radiometric
 * intensity (W/sr: P/4pi for point and spot lights, P/pi on the axis of area lights), which three.js
 * shades exactly as Cycles/EEVEE do, so 1 matches Blender. (The old 0.003 only undid a 683 lm/W
 * factor the exporter applied by mistake.) With ?debug, window.__csLightScale(v) tries values live.
 */
export const LIGHT_SCALE = 1;
const DECAY = 2;
const DISTANCE = 40;
const POOL_REFRESH_S = 0.4;
/** Glow sprite size in metres, by light kind. */
const GLOW_SIZE = { point: 1.5, spot: 2.5 } as const;
const scaledColor = new THREE.Color();

// Every real light gets the soft disk falloff I / (d^2 + r^2) of lightPools' LIGHT_RADIUS_M.
const ATTENUATION = "float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );";
if (THREE.ShaderChunk.lights_pars_begin.includes(ATTENUATION)) {
  THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin.replace(
    ATTENUATION,
    `float distanceFalloff = 1.0 / ( pow( lightDistance, decayExponent ) + ${(LIGHT_RADIUS_M * LIGHT_RADIUS_M).toFixed(4)} );`,
  );
} else console.warn("NightLights: three.js light attenuation code changed; lights keep their point falloff");

interface WorldLight {
  source: LightData;
  position: THREE.Vector3;
  /** Unit direction a spot (or area) light points along; null for point lights. */
  direction: THREE.Vector3 | null;
  color: THREE.Color;
}

/** A light's ground pool and its full colour (light colour times centre radiance). */
interface PoolEntry {
  light: WorldLight;
  pool: GroundPool;
  color: THREE.Color;
}

const POOL_SHAPES: PoolShape[] = ["spread", "cone"];

/** A light subset with its packed positions, for nearestIndices. */
interface LightSet {
  lights: WorldLight[];
  positions: Float32Array;
}

function lightSet(lights: WorldLight[]): LightSet {
  return { lights, positions: new Float32Array(lights.flatMap((light) => light.position.toArray())) };
}

function glowGeometry(lights: WorldLight[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lights.flatMap((l) => l.position.toArray())), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(lights.flatMap((l) => [l.color.r, l.color.g, l.color.b])), 3));
  return geometry;
}

/**
 * The scene's 176 lights are far too many to shade in a browser. Each gets a glow sprite, and a
 * small pool of real lights (6 point, 6 spot) moves to the lamps nearest the camera every 0.4 s, so
 * the ground and walls close by are lit. Every other light leaves a soft pool of light on the ground
 * below it (an additive decal, see lightPools.ts; spot and area lights aimed more than 60 degrees
 * from straight down leave none), so streets far from the camera, and the whole
 * city from the air, stay lit as in Blender. A light's pool goes dark while it is a real light.
 * The real-light count never changes, so the shaders compile once per light mode.
 * The light mode's nightLights level (1 at night) scales the pools and glow sprites; the 12 real lights
 * shine only at full level (night): below it they would barely show beside the sun, yet change every
 * shader, so golden hour shares daytime's shaders. At 0 (daytime) the whole group is hidden.
 */
export function NightLights({ data, collider = null }: { data: SceneData; collider?: THREE.Mesh | null }) {
  const camera = useThree((state) => state.camera);
  const glow = useLoader(THREE.TextureLoader, assetUrl("textures/glow.png"));
  const pointLights = useRef<(THREE.PointLight | null)[]>([]);
  const spotLights = useRef<(THREE.SpotLight | null)[]>([]);
  const poolMeshes = useRef<Record<PoolShape, THREE.InstancedMesh | null>>({ spread: null, cone: null });
  const timer = useRef(0);
  const scale = useRef(LIGHT_SCALE);
  const level = useApp((state) => LIGHT_MODES[state.activeLightMode].nightLights);
  const levelRef = useRef(level);
  levelRef.current = level;

  // With ?debug, window.__csLightScale(value) tries another scale live (for tuning against Blender).
  useEffect(() => {
    if (!import.meta.env.DEV && !location.search.includes("debug")) return;
    const setScale = (value: number) => {
      scale.current = value;
      timer.current = 0;
    };
    Object.assign(window, { __csLightScale: setScale });
    return () => {
      delete (window as unknown as { __csLightScale?: unknown }).__csLightScale;
    };
  }, []);

  const { all, points, spots, glows } = useMemo(() => {
    const world: WorldLight[] = localLights(data.lights).map((light) => ({
      source: light,
      position: toWorld(...light.pos),
      direction: light.kind === "spot" && light.dir ? toWorld(...light.dir).normalize() : null,
      color: new THREE.Color(...light.color),
    }));
    const pointLights = world.filter((light) => light.source.kind === "point");
    const spotLights = world.filter((light) => light.source.kind === "spot");
    return {
      all: world,
      points: lightSet(pointLights),
      spots: lightSet(spotLights),
      glows: { point: glowGeometry(pointLights), spot: glowGeometry(spotLights) },
    };
  }, [data]);

  // Ground pools, found on the walk collider once it is there (none without it), one instanced
  // mesh per falloff shape. Each entry keeps its full colour (light colour times centre radiance).
  const pools = useMemo(() => {
    const groups: Record<PoolShape, PoolEntry[]> = { spread: [], cone: [] };
    if (!collider) return groups;
    for (const light of all) {
      const pool = groundPool(collider, light.position, light.direction, light.source.angle, light.source.intensity);
      if (pool) groups[pool.shape].push({ light, pool, color: light.color.clone().multiplyScalar(pool.radiance) });
    }
    return groups;
  }, [all, collider]);
  const poolMaps = useMemo(() => ({ spread: poolTexture("spread"), cone: poolTexture("cone") }), []);

  useEffect(() => {
    const matrix = new THREE.Matrix4();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (const shape of POOL_SHAPES) {
      const mesh = poolMeshes.current[shape];
      if (!mesh) continue;
      pools[shape].forEach(({ pool, color }, i) => {
        const size = pool.radius * 2;
        matrix.compose(pool.center, flat, new THREE.Vector3(size, size, 1));
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    timer.current = 0;
  }, [pools]);

  // Spot lights aim at an object of their own, which has to be in the scene for its matrix to update.
  const spotTargets = useMemo(() => Array.from({ length: POOL_SPOTS }, () => new THREE.Object3D()), []);
  const black = useMemo(() => new THREE.Color(0, 0, 0), []);
  const glowColor = useMemo(() => new THREE.Color(level, level, level), [level]);

  // A new level reaches the lights and pools on the next frame.
  useEffect(() => {
    timer.current = 0;
  }, [level]);

  useFrame((_, delta) => {
    // Hidden by day: nothing to place.
    if (levelRef.current === 0) return;
    timer.current -= delta;
    if (timer.current > 0) return;
    timer.current = POOL_REFRESH_S;
    const real = new Set<WorldLight>();
    const assign = (set: LightSet, pool: (THREE.PointLight | THREE.SpotLight | null)[], count: number) => {
      const chosen = nearestIndices(set.positions, camera.position, count);
      for (let i = 0; i < count; i++) {
        const lamp = pool[i];
        if (!lamp) continue;
        const light = chosen[i] === undefined ? null : set.lights[chosen[i]];
        if (!light) {
          lamp.intensity = 0;
          continue;
        }
        real.add(light);
        lamp.position.copy(light.position);
        lamp.color.copy(light.color);
        lamp.intensity = light.source.intensity * scale.current * levelRef.current;
        if (lamp instanceof THREE.SpotLight) {
          lamp.angle = Math.min(light.source.angle ?? Math.PI / 4, Math.PI / 2);
          lamp.penumbra = light.source.blend ?? 0.15;
          lamp.target.position.copy(light.position).add(light.direction ?? new THREE.Vector3(0, -1, 0));
          lamp.target.updateMatrixWorld();
        }
      }
    };
    // Below full level the real lights are hidden (see above), so every pool shows.
    if (levelRef.current >= 1) {
      assign(points, pointLights.current, POOL_POINTS);
      assign(spots, spotLights.current, POOL_SPOTS);
    }
    // A real light lights the ground itself: its pool goes dark, every other pool shows.
    for (const shape of POOL_SHAPES) {
      const mesh = poolMeshes.current[shape];
      if (!mesh) continue;
      pools[shape].forEach(({ light, color }, i) => mesh.setColorAt(i, real.has(light) ? black : scaledColor.copy(color).multiplyScalar(scale.current * levelRef.current)));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group visible={level > 0}>
      {(["point", "spot"] as const).map((kind) => (
        <points key={kind} geometry={glows[kind]} frustumCulled={false} raycast={() => null}>
          <pointsMaterial
            map={glow}
            color={glowColor}
            size={GLOW_SIZE[kind]}
            sizeAttenuation
            vertexColors
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            fog={false}
          />
        </points>
      ))}
      {/* Remounted when the pools change, so the instance buffers are sized for them. */}
      {POOL_SHAPES.map(
        (shape) =>
          pools[shape].length > 0 && (
            <instancedMesh
              key={`${shape}${pools[shape].length}`}
              ref={(mesh) => {
                poolMeshes.current[shape] = mesh;
              }}
              args={[undefined, undefined, pools[shape].length]}
              frustumCulled={false}
              renderOrder={1}
              raycast={() => null}
            >
              <planeGeometry />
              <meshBasicMaterial map={poolMaps[shape]} transparent blending={THREE.AdditiveBlending} depthWrite={false} fog={false} />
            </instancedMesh>
          ),
      )}
      <group visible={level >= 1}>
        {Array.from({ length: POOL_POINTS }, (_, i) => (
          <pointLight
            key={`point${i}`}
            ref={(light) => {
              pointLights.current[i] = light;
            }}
            intensity={0}
            distance={DISTANCE}
            decay={DECAY}
          />
        ))}
        {spotTargets.map((target, i) => (
          <primitive key={`target${i}`} object={target} />
        ))}
        {spotTargets.map((target, i) => (
          <spotLight
            key={`spot${i}`}
            ref={(light) => {
              spotLights.current[i] = light;
            }}
            target={target}
            intensity={0}
            distance={DISTANCE}
            decay={DECAY}
          />
        ))}
      </group>
    </group>
  );
}
