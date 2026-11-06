import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { LightPreset } from "./lightModes";

// Adapted from AksarayCity web/src/environment/SkyDome.tsx: a gradient sky with drifting clouds.

export const skyVertex = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const skyFragment = /* glsl */ `
uniform vec3 skyTop;
uniform vec3 skyHorizon;
uniform vec3 groundColor;
uniform vec3 cloudColor;
uniform vec3 sunColor;
uniform vec3 sunDirection;
uniform float cloudOpacity;
uniform float sunGlow;
uniform float time;
varying vec3 vDirection;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  for (int i = 0; i < 5; i++) { value += noise(p) * amplitude; p = p * 2.03 + 17.0; amplitude *= 0.5; }
  return value;
}
void main() {
  vec3 dir = normalize(vDirection);
  float h = dir.y;
  vec3 color = mix(skyHorizon, skyTop, pow(clamp(h, 0.0, 1.0), 0.55));
  if (h > 0.0) {
    // Clouds on a flat layer overhead, so they compress naturally toward the horizon.
    vec2 plane = dir.xz / (h + 0.12);
    float cover = smoothstep(0.46, 0.68, fbm(plane * 1.3 + vec2(time * 0.004, 0.0)));
    color = mix(color, cloudColor, cover * cloudOpacity * smoothstep(0.0, 0.1, h));
  } else {
    color = mix(skyHorizon, groundColor, clamp(-h * 12.0, 0.0, 1.0));
  }
  float toSun = max(dot(dir, sunDirection), 0.0);
  color += sunColor * (pow(toSun, 400.0) * 1.2 + pow(toSun, 12.0) * 0.12) * sunGlow;
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}`;

type Dome = NonNullable<LightPreset["dome"]>;

/** The dome's shader material, set to a preset's colours (sunGlow 0 leaves the sun out, for the environment light). */
export function domeMaterial(dome: Dome, sunColor: string, sunDirection: THREE.Vector3, sunGlow: number) {
  return new THREE.ShaderMaterial({
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      skyTop: { value: new THREE.Color(dome.top) },
      skyHorizon: { value: new THREE.Color(dome.horizon) },
      groundColor: { value: new THREE.Color(dome.ground) },
      cloudColor: { value: new THREE.Color(dome.cloud) },
      sunColor: { value: new THREE.Color(sunColor) },
      sunDirection: { value: sunDirection.clone() },
      cloudOpacity: { value: dome.cloudOpacity },
      sunGlow: { value: sunGlow },
      time: { value: 0 },
    },
  });
}

/** A gradient sky with drifting clouds. It follows the camera, so it never gets closer. */
export function SkyDome({ dome, sunColor, sunDirection }: { dome: Dome; sunColor: string; sunDirection: THREE.Vector3 }) {
  const mesh = useRef<THREE.Mesh>(null);
  const camera = useThree((state) => state.camera);
  const material = useMemo(() => domeMaterial(dome, sunColor, sunDirection, 1), [dome, sunColor, sunDirection]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    material.uniforms.time.value = clock.getElapsedTime();
    mesh.current?.position.copy(camera.position);
  });

  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[1000, 32, 20]} />
    </mesh>
  );
}

const photoFragment = /* glsl */ `
#include <common>
uniform sampler2D photo;
uniform mat3 turn;
uniform float intensity;
uniform vec3 groundColor;
uniform vec3 hazeColor;
varying vec3 vDirection;
void main() {
  vec3 dir = normalize(vDirection);
  // Above the horizon the photograph; below it, the haze at the horizon fading into the ground.
  vec3 look = turn * vec3(dir.x, max(dir.y, 0.002), dir.z);
  vec3 sky = texture2D(photo, equirectUv(normalize(look))).rgb * intensity;
  float below = clamp(-dir.y * 10.0, 0.0, 1.0);
  // The haze starts above the horizon and fades out over about 6 degrees, so there is no step at the horizon line.
  float hazeAbove = 0.6 * (1.0 - smoothstep(0.0, 0.1, dir.y));
  vec3 horizon = mix(sky, hazeColor, 0.6);
  vec3 color = dir.y >= 0.0 ? mix(sky, hazeColor, hazeAbove) : mix(horizon, groundColor, below);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The photographed daytime sky as a dome that follows the camera: the picture above the horizon
 * (turned like the environment light), and below it, where the photo only has more sky, ground
 * fading out of the haze, so the city stands on land and not in the air.
 */
export function PhotoDome({ texture, turn, intensity, ground, haze }: { texture: THREE.Texture; turn: number; intensity: number; ground: string; haze: string }) {
  const mesh = useRef<THREE.Mesh>(null);
  const camera = useThree((state) => state.camera);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: skyVertex,
        fragmentShader: photoFragment,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          photo: { value: null },
          turn: { value: new THREE.Matrix3() },
          intensity: { value: 1 },
          groundColor: { value: new THREE.Color() },
          hazeColor: { value: new THREE.Color() },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    const u = material.uniforms;
    u.photo.value = texture;
    // The renderer's own background lookup: the transpose of the y rotation.
    u.turn.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(turn)).transpose();
    u.intensity.value = intensity;
    u.groundColor.value.set(ground);
    u.hazeColor.value.set(haze);
  }, [material, texture, turn, intensity, ground, haze]);

  useFrame(() => {
    mesh.current?.position.copy(camera.position);
  });

  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[1000, 48, 24]} />
    </mesh>
  );
}
