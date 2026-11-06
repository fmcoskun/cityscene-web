import * as THREE from "three";
import type { MaterialOverride } from "../data/types";

/** A web stand-in for a Blender material the glTF exporter cannot carry (emission, glass). */
export function buildOverrideMaterial(name: string, override: MaterialOverride): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
  if (override.type === "glass") {
    return new THREE.MeshPhysicalMaterial({
      name,
      color: override.color,
      roughness: override.roughness,
      metalness: override.metalness,
      transparent: true,
      opacity: override.opacity ?? 0.3,
      transmission: override.transmission ?? 1,
      // Glass is drawn after the solid scene and must not hide what is behind it.
      depthWrite: false,
    });
  }
  return new THREE.MeshStandardMaterial({
    name,
    color: override.color,
    emissive: override.emissive ?? override.color,
    emissiveIntensity: override.emissiveIntensity ?? 1,
    roughness: override.roughness,
    metalness: override.metalness,
    toneMapped: true,
  });
}

/**
 * The override key for a glTF material name. The exporter keeps override names exactly, but
 * baked copies are named "<material>@<object>" and Blender duplicates end in ".NNN"; those
 * fall back to the base name, and only when that base is itself an override key.
 */
export function overrideKey(name: string, overrides: Record<string, MaterialOverride>): string | null {
  if (Object.hasOwn(overrides, name)) return name;
  const base = name.split("@")[0].replace(/\.\d{3}$/, "");
  return base !== name && Object.hasOwn(overrides, base) ? base : null;
}

/** Swaps every material whose name matches an override; returns how many slots changed. */
export function applyOverrides(root: THREE.Object3D, overrides: Record<string, MaterialOverride>): number {
  const built = new Map<string, THREE.Material>();
  const replacement = (material: THREE.Material) => {
    const key = overrideKey(material.name, overrides);
    if (key === null) return null;
    let made = built.get(key);
    if (!made) {
      made = buildOverrideMaterial(key, overrides[key]);
      built.set(key, made);
    }
    return made;
  };
  let changed = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => {
        const made = replacement(material);
        if (!made) return material;
        changed++;
        return made;
      });
    } else {
      const made = replacement(mesh.material);
      if (made) {
        mesh.material = made;
        changed++;
      }
    }
  });
  return changed;
}

/**
 * Sets every glowing material to `level` times its own emission: the overrides above and the
 * baked materials whose glow came through KHR_materials_emissive_strength (GLTFLoader puts it in
 * emissiveIntensity). The original intensity is kept in userData the first time, so the level is
 * always taken from it and repeated calls never compound. Materials without an emissive colour are skipped.
 */
export function scaleEmission(materials: Iterable<THREE.Material>, level: number) {
  for (const material of materials) {
    const standard = material as THREE.MeshStandardMaterial;
    if (!standard.emissive) continue;
    if (typeof standard.userData.baseEmissiveIntensity !== "number") standard.userData.baseEmissiveIntensity = standard.emissiveIntensity;
    standard.emissiveIntensity = standard.userData.baseEmissiveIntensity * level;
  }
}

/** Every distinct material on the meshes under `root`. */
export function sceneMaterials(root: THREE.Object3D): Set<THREE.Material> {
  const found = new Set<THREE.Material>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) for (const material of [mesh.material].flat()) found.add(material);
  });
  return found;
}
