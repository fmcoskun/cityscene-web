import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import type * as THREE from "three";
import { assetUrl } from "../data/loadData";
import type { SceneData } from "../data/types";
import { applyOverrides } from "./materials";

const CITY_URL = assetUrl("models/city.glb");

/**
 * Every solid mesh casts and takes the sun's shadow (only the daytime and golden-hour sun casts
 * any). See-through materials (the glass overrides) do not cast: sunlight passes through windows.
 */
function castSunShadows(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
    mesh.castShadow = [mesh.material].flat().every((material) => !(material.transparent && material.opacity < 1));
  });
}

/** The exported city, meshopt-compressed, with emission and glass rebuilt from scene.json. */
export function CityModel({ data, onLoaded }: { data: SceneData; onLoaded: (overridden: number) => void }) {
  // No Draco; meshopt decoder on.
  const gltf = useGLTF(CITY_URL, false, true);
  const overridden = useMemo(() => {
    const count = applyOverrides(gltf.scene, data.overrides);
    castSunShadows(gltf.scene);
    return count;
  }, [gltf, data]);

  useEffect(() => {
    if (import.meta.env.DEV || location.search.includes("debug")) Object.assign(window, { __csOverrides: overridden });
    onLoaded(overridden);
  }, [overridden, onLoaded]);

  return <primitive object={gltf.scene} />;
}
