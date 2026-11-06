import { useThree } from "@react-three/fiber";
import { use, useLayoutEffect } from "react";
import * as THREE from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { assetUrl } from "../data/loadData";
import type { SceneData } from "../data/types";
import { useApp } from "../store";
import { LIGHT_MODES } from "./lightModes";
import { loadSkyOrNull } from "./skyTexture";

const FALLBACK = "#0b0d14";

/** One load per file for the page's lifetime; a failed load settles to null. */
const skyLoads = new Map<string, Promise<THREE.Texture | null>>();

function loadSky(file: string): Promise<THREE.Texture | null> {
  let pending = skyLoads.get(file);
  if (!pending) {
    const hdr = file.toLowerCase().endsWith(".hdr");
    const loader = hdr ? new HDRLoader() : new THREE.TextureLoader();
    pending = loadSkyOrNull(async () => {
      const texture = await loader.loadAsync(assetUrl(file));
      texture.mapping = THREE.EquirectangularReflectionMapping;
      if (!hdr) texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }, file);
    skyLoads.set(file, pending);
  }
  return pending;
}

/**
 * Blender's world texture as background and image-based light. Blender's z rotation is a turn
 * about three.js' y axis, and both map an equirectangular image's centre to +x, so no offset.
 * The world strength (0.2 for this night scene) becomes the background and environment intensity.
 * Without a sky file, or when it fails to load, the background is plain dark.
 * Only the night mode shows it; by day DaylightRig sets the sky. The texture stays loaded either way.
 */
export function Sky({ data }: { data: SceneData }) {
  const { file, rotation_z, strength } = data.sky;
  const active = useApp((state) => LIGHT_MODES[state.activeLightMode].sky === "night");
  return file ? <SkyMap file={file} rotation={rotation_z} strength={strength} active={active} /> : <SkyApply texture={null} rotation={0} strength={1} active={active} />;
}

function SkyMap({ file, rotation, strength, active }: { file: string; rotation: number; strength: number; active: boolean }) {
  // Suspends until the load settles, inside the same boundary as the city.
  const texture = use(loadSky(file));
  return <SkyApply texture={texture} rotation={rotation} strength={strength} active={active} />;
}

function SkyApply({ texture, rotation, strength, active }: { texture: THREE.Texture | null; rotation: number; strength: number; active: boolean }) {
  const scene = useThree((state) => state.scene);

  useLayoutEffect(() => {
    if (!active) return;
    scene.background = texture ?? new THREE.Color(FALLBACK);
    scene.environment = texture;
    scene.backgroundRotation.set(0, rotation, 0);
    scene.environmentRotation.set(0, rotation, 0);
    scene.backgroundIntensity = strength;
    scene.environmentIntensity = strength;
    return () => {
      scene.background = null;
      scene.environment = null;
      scene.backgroundRotation.set(0, 0, 0);
      scene.environmentRotation.set(0, 0, 0);
      scene.backgroundIntensity = 1;
      scene.environmentIntensity = 1;
    };
  }, [texture, scene, rotation, strength, active]);

  return null;
}
