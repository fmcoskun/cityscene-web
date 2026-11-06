import * as THREE from "three";

// Blender uses z-up, three.js uses y-up. The GLB exporter applies this same mapping.
export function toWorld(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(x, z, -y);
}

/** Plan position (Blender x, y) of a three.js point. */
export function toPlan(point: THREE.Vector3): [number, number] {
  return [point.x, -point.z];
}
