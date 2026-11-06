import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { LightData } from "../data/types";

/**
 * Ground pools: the light a lamp leaves on the ground, drawn as a flat additive decal instead of
 * shading the scene with it. Its centre carries the radiance a Lambert surface of POOL_ALBEDO would
 * reflect there (E * albedo / pi, E the irradiance from the light), in the same units as the real
 * lights, so a pool and the real light that replaces it near the camera look alike.
 */
export interface GroundPool {
  /** Centre on the ground (lifted a little against z-fighting), three.js axes. */
  center: THREE.Vector3;
  radius: number;
  /** Radiance at the centre, per unit of light colour, before the light scale. */
  radiance: number;
  /** "spread": a point or wide (area) light, falling off with distance; "cone": a narrow spot's footprint. */
  shape: PoolShape;
}

export type PoolShape = "spread" | "cone";

/** A dark-grey albedo, as asphalt and worn paving; matched by eye against the real lights next to pools. */
export const POOL_ALBEDO = 0.18;
/** Kept well under the bloom threshold, so pools light the ground without glowing. */
export const MAX_POOL_RADIANCE = 0.5;
/**
 * Spot and area lights whose axis is further than this from straight down (60 degrees) send too
 * little light to the ground below for a pool; they light walls (facades, signs) instead.
 */
export const MIN_DOWN_COS = 0.5;
/**
 * Blender's lights have a size (0.25-1 m here), so their light stays finite next to a wall; three.js
 * lights are points whose 1/d^2 burns a wall white a few centimetres away. A disk light of radius r
 * gives I / (d^2 + r^2) on its axis; NightLights applies that to every real light and the pools
 * use the same r.
 */
export const LIGHT_RADIUS_M = 0.5;

/**
 * The lights the night scene draws: point and spot (area lights arrive as spots). Sun lights light
 * a whole scene from infinitely far, which the nearest-light pool and the ground pools cannot
 * stand for, so they are left out (the exporter warns about each one).
 */
export function localLights<T extends Pick<LightData, "kind">>(lights: T[]): T[] {
  return lights.filter((light) => light.kind === "point" || light.kind === "spot");
}
const MIN_RADIUS_M = 1;
const MAX_RADIUS_M = 18;
/** A spread pool's falloff reaches its edge at this many light heights from the centre. */
const EDGE_IN_HEIGHTS = 2.5;
/** Spots with a half angle under this (about 69 degrees) light a cone footprint; wider ones spread. */
const CONE_MAX_ANGLE = 1.2;
/** Nearer hits are the lamp's own housing, not the ground. */
const SKIP_M = 0.3;
const LIFT_M = 0.05;
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Pool size, shape and centre radiance for a light `height` above the pool centre, `distance` from
 * it along its axis, the axis meeting the ground at cosine `downCos` (1 straight down).
 * The irradiance at the centre is I * downCos / (d^2 + r^2): the light's on-axis intensity, spread
 * over ground tilted away from the axis, so a light aimed at a slant leaves a dimmer pool.
 */
export function poolShape(height: number, distance: number, downCos: number, angle: number | null, intensity: number) {
  const shape: PoolShape = angle !== null && angle <= CONE_MAX_ANGLE ? "cone" : "spread";
  const reach = shape === "cone" ? distance * Math.tan(angle!) * 1.05 : EDGE_IN_HEIGHTS * height;
  const radius = THREE.MathUtils.clamp(reach, MIN_RADIUS_M, MAX_RADIUS_M);
  const irradiance = (intensity * downCos) / (distance * distance + LIGHT_RADIUS_M * LIGHT_RADIUS_M);
  return { shape, radius, radiance: Math.min((irradiance * POOL_ALBEDO) / Math.PI, MAX_POOL_RADIANCE) };
}

/**
 * Where a light first meets the walk collider beyond its own housing: straight down for point
 * lights, along the axis for spot and area lights. A pool only when that is ground (a level face)
 * below the light; a spot or area light aimed more than 60 degrees from straight down, or blocked
 * by a wall, leaves none.
 */
export function groundPool(collider: THREE.Mesh, position: THREE.Vector3, direction: THREE.Vector3 | null, angle: number | null, intensity: number): GroundPool | null {
  const bvh = collider.geometry.boundsTree as MeshBVH | undefined;
  if (!bvh) return null;
  const axis = direction ?? DOWN;
  const downCos = -axis.y;
  if (downCos < MIN_DOWN_COS) return null;
  const ray = new THREE.Ray(position.clone(), axis.clone());
  const hit = bvh
    .raycast(ray, THREE.DoubleSide, SKIP_M, 60)
    .filter((h) => h.distance > SKIP_M)
    .sort((a, b) => a.distance - b.distance)[0];
  if (!hit?.face || Math.abs(hit.face.normal.y) < 0.7) return null;
  const height = position.y - hit.point.y;
  if (height < SKIP_M) return null;
  const { shape, radius, radiance } = poolShape(height, hit.distance, downCos, direction ? angle : null, intensity);
  return { center: hit.point.clone().setY(hit.point.y + LIFT_M), radius, radiance, shape };
}

/**
 * Pool falloff from the centre (t = 0) to the edge (t = 1), 1 at the centre.
 * spread: the floor under a point light, E(r) ~ (1 + u^2)^-3/2 with u = r / h, and the edge at
 * 2.5 h, faded to 0 there. cone: a spot's footprint, nearly flat, with a soft rim over its outer fifth.
 */
export function poolFalloff(t: number, shape: PoolShape = "spread") {
  if (shape === "cone") return 1 - THREE.MathUtils.smoothstep(t, 0.8, 1);
  const edge = (1 + EDGE_IN_HEIGHTS ** 2) ** -1.5;
  const u = EDGE_IN_HEIGHTS * t;
  return Math.max(0, ((1 + u * u) ** -1.5 - edge) / (1 - edge));
}

/** A white texture whose alpha is the pool falloff (additive blending multiplies colour by alpha). */
export function poolTexture(shape: PoolShape, size = 128) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      pixels.set([255, 255, 255, Math.round(poolFalloff(Math.min(t, 1), shape) * 255)], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
