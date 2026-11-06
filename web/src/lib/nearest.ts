import type * as THREE from "three";

/**
 * Indices of the points (packed x, y, z) nearest to `from`, nearest first, at most `count`.
 * A plain sort: it runs a few times a second over a couple of hundred lights.
 */
export function nearestIndices(positions: Float32Array, from: THREE.Vector3, count: number): number[] {
  const total = Math.floor(positions.length / 3);
  const distances = new Float64Array(total);
  const order: number[] = [];
  for (let i = 0; i < total; i++) {
    const dx = positions[i * 3] - from.x;
    const dy = positions[i * 3 + 1] - from.y;
    const dz = positions[i * 3 + 2] - from.z;
    distances[i] = dx * dx + dy * dy + dz * dz;
    order.push(i);
  }
  order.sort((a, b) => distances[a] - distances[b]);
  return order.slice(0, Math.max(0, count));
}
