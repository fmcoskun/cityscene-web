import * as THREE from "three";
import type { SceneData } from "../data/types";
import { toWorld } from "../lib/coords";
import type { CameraMode, LightMode } from "../store";
import { scaleEmission } from "./materials";

export type { LightMode };

export type SkyKind = "photo" | "dome" | "night";

export interface LightPreset {
  /** Blender elevation and azimuth (degrees from north = Blender +y, turning east); null: no sun. */
  sun: { elevationDeg: number; azimuthDeg: number; color: string; intensity: number } | null;
  sky: SkyKind;
  /** Fill light, so faces turned from the sun are not black (the baked textures carry no ambient occlusion). */
  hemi: { sky: string; ground: string; intensity: number };
  exposure: number;
  toneMapping: "agx" | "aces";
  /** 0..1 on the night lights: the real lights near the camera, the ground pools and the glow sprites. */
  nightLights: number;
  bloomStrength: { aerial: number; street: number };
  /** Multiplier on every glowing material's own emission. */
  emissionLevel: number;
  shadows: boolean;
  /** The generated sky (golden hour, and daytime when the photographed sky cannot load). */
  dome?: { top: string; horizon: string; ground: string; cloud: string; cloudOpacity: number };
  fog?: { color: string; density: number };
  /** Image-based light from the sky (photo or dome), as scene.environmentIntensity. */
  environment?: number;
  /**
   * The photographed sky: its brightness on screen, how far the light it gives is moved toward grey,
   * and the ground drawn below the horizon (the photo has only sky there).
   */
  photo?: { background: number; soften: number; ground: string };
}

/**
 * The three lighting modes. Daytime and golden hour come from AksarayCity (config/city_config.json:
 * the web presets for sky colours, exposure and fill, the Blender lighting for sun direction, colour
 * and the emission level), adapted to this scene: fog is a light haze only (the scene is a tenth of
 * that size), and the sun is about twice as strong with the sky's light at half or less, tuned by eye
 * on stills; with AksarayCity's ratio the sky drowned the sun and shadows hardly showed on these baked textures.
 * Night is this scene as it was before the modes existed, value for value.
 */
export const LIGHT_MODES: Record<LightMode, LightPreset> = {
  daytime: {
    sun: { elevationDeg: 50, azimuthDeg: 145, color: "#fff3e2", intensity: 6 },
    sky: "photo",
    hemi: { sky: "#d8dfe4", ground: "#8c8466", intensity: 0.25 },
    exposure: 0.7,
    toneMapping: "aces",
    nightLights: 0,
    bloomStrength: { aerial: 0, street: 0 },
    emissionLevel: 0.08,
    shadows: true,
    dome: { top: "#5f8ec4", horizon: "#d8dfe4", ground: "#8c8466", cloud: "#f3f2ee", cloudOpacity: 0.85 },
    fog: { color: "#c9d3da", density: 0.0012 },
    environment: 0.8,
    photo: { background: 1.2, soften: 0.5, ground: "#6f6d62" },
  },
  golden_hour: {
    sun: { elevationDeg: 9, azimuthDeg: 258, color: "#ffb06a", intensity: 6 },
    sky: "dome",
    hemi: { sky: "#efc398", ground: "#7d654e", intensity: 0.3 },
    exposure: 0.9,
    toneMapping: "agx",
    nightLights: 0.25,
    bloomStrength: { aerial: 0.05, street: 0.2 },
    emissionLevel: 0.25,
    shadows: true,
    dome: { top: "#5f7fa8", horizon: "#efc398", ground: "#7d654e", cloud: "#f2b892", cloudOpacity: 0.85 },
    fog: { color: "#dcb48f", density: 0.0016 },
    environment: 0.5,
  },
  night: {
    sun: null,
    sky: "night",
    hemi: { sky: "#000000", ground: "#000000", intensity: 0 },
    exposure: 1,
    toneMapping: "agx",
    nightLights: 1,
    bloomStrength: { aerial: 0.15, street: 0.5 },
    emissionLevel: 1,
    shadows: false,
  },
};

export const TONE_MAPPINGS = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping } as const;

const RAD = Math.PI / 180;

/** Unit vector toward the sun in three.js axes, from Blender's elevation and azimuth (as AksarayCity's web_data.py). */
export function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const elevation = elevationDeg * RAD;
  const azimuth = azimuthDeg * RAD;
  return toWorld(Math.sin(azimuth) * Math.cos(elevation), Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation)).normalize();
}

/**
 * A fixed shadow box holding the whole scene from any sun direction: the bounding sphere of the
 * scene's box. The light sits `distance` from `center` toward the sun and looks at the centre.
 */
export function shadowFrustum(bounds: SceneData["bounds"]) {
  const min = toWorld(...bounds.min);
  const max = toWorld(...bounds.max);
  const box = new THREE.Box3().setFromPoints([min, max]);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.ceil(box.getSize(new THREE.Vector3()).length() / 2) + 1;
  const margin = 5;
  return { left: -radius, right: radius, top: radius, bottom: -radius, near: 1, far: 2 * radius + 2 * margin, center, distance: radius + margin };
}

/** The sky actually shown: a photographed sky that failed to load gives way to the generated dome. */
export function chooseSky(wanted: SkyKind, photoFailed: boolean): SkyKind {
  return wanted === "photo" && photoFailed ? "dome" : wanted;
}

/** Bloom strength: street strength at walking height, the faint one from the air and in orbit. */
export function bloomFor(preset: LightPreset, cameraMode: CameraMode) {
  return cameraMode === "walk" ? preset.bloomStrength.street : preset.bloomStrength.aerial;
}

/** The y rotation that shows the photo's sun (three.js direction) toward `wanted` (renderer shows d at Ry(turn) d). */
export function photoRotation(photoSun: THREE.Vector3, wanted: THREE.Vector3) {
  return Math.atan2(photoSun.z, photoSun.x) - Math.atan2(wanted.z, wanted.x);
}

/** What applyPreset touches outside the React tree. */
export interface ModeTargets {
  renderer: { toneMapping: THREE.ToneMapping; toneMappingExposure: number };
  scene: { fog: THREE.Fog | THREE.FogExp2 | null };
  bloom: { strength: number; enabled: boolean } | null;
  materials: Iterable<THREE.Material>;
}

/**
 * Sets tone mapping, exposure, fog, bloom and the glowing materials for a mode, and returns the
 * values it set. Everything comes from the preset (emission from each material's own original), so
 * going back to a mode gives exactly what it gave before.
 */
export function applyPreset(targets: ModeTargets, preset: LightPreset, cameraMode: CameraMode) {
  const { renderer, scene, bloom } = targets;
  renderer.toneMapping = TONE_MAPPINGS[preset.toneMapping];
  renderer.toneMappingExposure = preset.exposure;
  if (preset.fog) {
    // An existing fog is updated, so the shaders (which only know there is fog) stay as they are.
    const fog = scene.fog instanceof THREE.FogExp2 ? scene.fog : new THREE.FogExp2(preset.fog.color, preset.fog.density);
    fog.color.set(preset.fog.color);
    fog.density = preset.fog.density;
    scene.fog = fog;
  } else scene.fog = null;
  if (bloom) {
    bloom.strength = bloomFor(preset, cameraMode);
    bloom.enabled = bloom.strength > 0;
  }
  const materials = [...targets.materials];
  scaleEmission(materials, preset.emissionLevel);
  return {
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    fog: scene.fog instanceof THREE.FogExp2 ? { color: scene.fog.color.getHex(), density: scene.fog.density } : null,
    bloom: bloom ? { ...bloom } : null,
    emission: materials.map((material) => (material as THREE.MeshStandardMaterial).emissiveIntensity ?? 0),
  };
}

/** Moves RGBA sky pixels toward grey. Clear blue sky otherwise tints every wall in shade violet. (AksarayCity lib/sun.ts) */
export function softenSky(data: Float32Array, amount: number) {
  for (let i = 0; i < data.length; i += 4) {
    const grey = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    for (let channel = 0; channel < 3; channel++) data[i + channel] += (grey - data[i + channel]) * amount;
  }
}

/**
 * Finds the sun in an equirectangular sky and clamps it out of the data, because the scene's
 * directional light is the sun and the sky should only add ambient light. Returns a unit vector
 * toward the photographed sun in three.js axes. (AksarayCity lib/sun.ts)
 */
export function findSunAndClamp(data: Float32Array, width: number, height: number, limit: number): THREE.Vector3 {
  let brightest = -1;
  let sunIndex = 0;
  for (let i = 0; i < width * height; i++) {
    const value = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    if (value > brightest) {
      brightest = value;
      sunIndex = i;
    }
    for (let channel = 0; channel < 3; channel++) data[i * 4 + channel] = Math.min(data[i * 4 + channel], limit);
  }
  const row = Math.floor(sunIndex / width);
  const column = sunIndex % width;
  const longitude = (column / width - 0.5) * Math.PI * 2;
  // Row order differs between loaders, so the side of the horizon is taken from the sky being above it.
  const elevation = Math.abs(Math.PI / 2 - (row / height) * Math.PI);
  return new THREE.Vector3(Math.cos(elevation) * Math.cos(longitude), Math.sin(elevation), Math.cos(elevation) * Math.sin(longitude));
}
