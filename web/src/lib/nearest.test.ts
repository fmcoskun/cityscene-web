import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { nearestIndices } from "./nearest";

const origin = new THREE.Vector3(0, 0, 0);

describe("nearestIndices", () => {
  const points = new Float32Array([
    10, 0, 0, // 0: 10 m
    0, 3, 0, // 1: 3 m
    0, 0, -7, // 2: 7 m
    1, 1, 1, // 3: ~1.73 m
    -20, 5, 5, // 4: ~21 m
  ]);

  it("returns the nearest indices, nearest first", () => {
    expect(nearestIndices(points, origin, 2)).toEqual([3, 1]);
  });

  it("returns every index, sorted by distance, when count exceeds the points", () => {
    expect(nearestIndices(points, origin, 10)).toEqual([3, 1, 2, 0, 4]);
  });

  it("measures from the given point", () => {
    expect(nearestIndices(points, new THREE.Vector3(-19, 5, 5), 1)).toEqual([4]);
  });

  it("returns nothing for no points", () => {
    expect(nearestIndices(new Float32Array(0), origin, 3)).toEqual([]);
  });
});
