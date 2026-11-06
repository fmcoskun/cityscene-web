import type * as THREE from "three";

/**
 * Runs the sky loader and turns a failure (missing file, bad HDR) into null, so the scene falls
 * back to a plain dark background instead of failing as a whole.
 */
export async function loadSkyOrNull(load: () => Promise<THREE.Texture>, label: string): Promise<THREE.Texture | null> {
  try {
    return await load();
  } catch (error) {
    console.warn(`Gökyüzü yüklenemedi (${label}), düz arka plan kullanılıyor:`, error);
    return null;
  }
}
