import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCollider, CAPSULE_HEIGHT_M, EYE_HEIGHT_M, findSpawn, streetLevel, Walker } from "./walker";

// Test scene, three.js axes (y up):
//   ground plane 40 x 40 m at y = 0, centred on the origin
//   closed building box 10 x 4 x 10 m: x 5..15, z -5..5
//   0.3 m step box: x -2..2, z 8..12;   0.6 m step box: x -12..-8, z 8..12
//   3 m platform: x -13..-7, z -13..-7
function box(width: number, height: number, depth: number, x: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
  mesh.position.set(x, height / 2, z);
  return mesh;
}

function testScene() {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40));
  ground.rotation.x = -Math.PI / 2;
  root.add(ground, box(10, 4, 10, 10, 0), box(4, 0.3, 4, 0, 10), box(4, 0.6, 4, -10, 10), box(6, 3, 6, -10, -10));
  return buildCollider(root);
}

const collider = testScene();
const respawn = new THREE.Vector3(0, 0, -17);

function walker(x: number, y: number, z: number) {
  const w = new Walker(collider, { minY: -10, respawn });
  w.feet.set(x, y, z);
  return w;
}

/** Steps the walker at 60 frames a second for `seconds`. */
function walk(w: Walker, seconds: number, move: THREE.Vector3) {
  for (let t = 0; t < seconds; t += 1 / 60) w.step(1 / 60, move);
}

const still = new THREE.Vector3();

describe("buildCollider", () => {
  it("dequantizes normalized Int16 positions through a scaled parent into world space", () => {
    // A quantized triangle, as KHR_mesh_quantization stores it: normalized Int16 in -1..1.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Int16Array([-32767, 0, -32767, 32767, 0, -32767, 0, 32767, 32767]), 3, true));
    const parent = new THREE.Group();
    parent.scale.setScalar(50);
    parent.position.set(10, 2, -3);
    parent.add(new THREE.Mesh(geometry));
    const root = new THREE.Group();
    root.add(parent);

    const result = buildCollider(root);
    const position = result.geometry.getAttribute("position");
    expect(position.array).toBeInstanceOf(Float32Array);
    expect(position.normalized).toBe(false);
    const bounds = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
    expect(bounds.min.x).toBeCloseTo(-40, 3);
    expect(bounds.max.x).toBeCloseTo(60, 3);
    expect(bounds.min.y).toBeCloseTo(2, 3);
    expect(bounds.max.y).toBeCloseTo(52, 3);
    expect(bounds.min.z).toBeCloseTo(-53, 3);
    expect(bounds.max.z).toBeCloseTo(47, 3);
    expect(result.geometry.boundsTree).toBeDefined();
  });

  it("merges every mesh, with indices offset per mesh", () => {
    expect(collider.geometry.boundsTree).toBeDefined();
    const bounds = new THREE.Box3().setFromBufferAttribute(collider.geometry.getAttribute("position") as THREE.BufferAttribute);
    const rounded = (v: THREE.Vector3) => v.toArray().map((value) => Math.round(value * 1000) / 1000 + 0);
    expect(rounded(bounds.min)).toEqual([-20, 0, -20]);
    expect(rounded(bounds.max)).toEqual([20, 4, 20]);
    // Three box meshes and the plane: every triangle carried over.
    expect(collider.geometry.index!.count / 3).toBe(2 + 3 * 12 + 12);
  });
});

describe("Walker", () => {
  it("walks on flat ground", () => {
    const w = walker(0, 0, -17);
    walk(w, 1, new THREE.Vector3(3.2, 0, 0));
    expect(w.feet.x).toBeCloseTo(3.2, 1);
    expect(w.feet.y).toBeCloseTo(0, 2);
    expect(w.feet.z).toBeCloseTo(-17, 2);
    expect(w.onGround).toBe(true);
  });

  it("stops at a wall", () => {
    const w = walker(0, 0, 0);
    walk(w, 3, new THREE.Vector3(3.2, 0, 0));
    expect(w.feet.x).toBeLessThanOrEqual(5 - 0.39);
    expect(w.feet.x).toBeGreaterThan(4.4);
    expect(w.feet.z).toBeCloseTo(0, 2);
  });

  it("climbs a 0.3 m step", () => {
    const w = walker(0, 0, 6);
    walk(w, 1.5, new THREE.Vector3(0, 0, 3.2));
    walk(w, 0.3, still);
    expect(w.feet.z).toBeGreaterThan(9);
    expect(w.feet.y).toBeCloseTo(0.3, 2);
    expect(w.onGround).toBe(true);
  });

  it("is blocked by a 0.6 m step", () => {
    const w = walker(-10, 0, 6);
    walk(w, 2, new THREE.Vector3(0, 0, 3.2));
    expect(w.feet.z).toBeLessThanOrEqual(8 - 0.39);
    expect(w.feet.y).toBeCloseTo(0, 2);
  });

  it("falls off a ledge", () => {
    const w = walker(-10, 3, -10);
    walk(w, 0.2, still);
    expect(w.feet.y).toBeCloseTo(3, 2);
    walk(w, 2, new THREE.Vector3(0, 0, 3.2));
    walk(w, 1, still);
    expect(w.feet.z).toBeGreaterThan(-7);
    expect(w.feet.y).toBeCloseTo(0, 2);
    expect(w.onGround).toBe(true);
  });

  it("large delta does not tunnel", () => {
    const w = walker(3, 0, 0);
    w.step(2.0, new THREE.Vector3(8, 0, 0));
    expect(w.feet.x).toBeLessThanOrEqual(5 - 0.39);
    expect(w.feet.y).toBeCloseTo(0, 2);
  });

  it("a lone single-sided plane wall stops a large delta from either side", () => {
    // One PlaneGeometry (two triangles, no thickness) at x = 5, its face towards -x.
    const root = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40));
    ground.rotation.x = -Math.PI / 2;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 4));
    wall.rotation.y = -Math.PI / 2;
    wall.position.set(5, 2, 0);
    root.add(ground, wall);
    const scene = buildCollider(root);
    const front = new Walker(scene, { minY: -10 });
    front.feet.set(3, 0, 0);
    front.step(2.0, new THREE.Vector3(8, 0, 0));
    expect(front.feet.x).toBeLessThanOrEqual(5 - 0.39);
    expect(front.feet.x).toBeGreaterThan(4.5);
    const back = new Walker(scene, { minY: -10 });
    back.feet.set(7, 0, 0);
    back.step(2.0, new THREE.Vector3(-8, 0, 0));
    expect(back.feet.x).toBeGreaterThanOrEqual(5 + 0.39);
    expect(back.feet.x).toBeLessThan(5.5);
  });

  it("the capsule reaches above the eye, so a 1.85 m ceiling blocks the way", () => {
    // A 0.4 m slab whose underside is 1.85 m above the ground, x 3..7: 10 cm above the eye.
    const root = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40));
    ground.rotation.x = -Math.PI / 2;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 10));
    slab.position.set(5, 1.85 + 0.2, 0);
    root.add(ground, slab);
    const scene = buildCollider(root);
    expect(CAPSULE_HEIGHT_M).toBeCloseTo(EYE_HEIGHT_M + 0.15, 6);
    const forward = new THREE.Vector3(3.2, 0, 0);
    const w = new Walker(scene, { minY: -10 });
    w.feet.set(0, 0, 0);
    walk(w, 4, forward);
    expect(w.feet.x).toBeLessThan(3);
    expect(w.feet.y).toBeGreaterThan(-0.05);
    // The margin is what stops it: a capsule only as tall as the eye walks under the slab.
    const eyeTall = new Walker(scene, { minY: -10, height: EYE_HEIGHT_M });
    eyeTall.feet.set(0, 0, 0);
    walk(eyeTall, 4, forward);
    expect(eyeTall.feet.x).toBeGreaterThan(7);
  });

  it("falling below the scene respawns", () => {
    // Under the ground plane there is nothing to land on.
    const w = walker(0, -5, 0);
    walk(w, 5, still);
    expect(w.feet.x).toBeCloseTo(respawn.x, 3);
    expect(w.feet.y).toBeCloseTo(respawn.y, 3);
    expect(w.feet.z).toBeCloseTo(respawn.z, 3);
    expect(w.respawns).toBe(1);
  });
});

describe("Walker scene limit", () => {
  const west = new THREE.Vector3(-4, 0, 0);

  it("walking towards the limit stops at it, on the ground", () => {
    const w = new Walker(collider, { minY: -10, respawn, limit: { center: new THREE.Vector3(0, 0, 0), half: [10, 10] } });
    w.feet.set(0, 0, -3);
    walk(w, 5, west);
    expect(w.feet.x).toBeCloseTo(-10, 3);
    expect(w.onGround).toBe(true);
    expect(w.respawns).toBe(0);
  });

  it("stops at the limit although the ground goes on past it", () => {
    // The ground runs to x = -20; the limit, off-centre, ends at x = -6.
    const w = new Walker(collider, { minY: -10, respawn, limit: { center: new THREE.Vector3(-1, 0, 0), half: [5, 30] } });
    w.feet.set(0, 0, -15);
    walk(w, 5, west);
    expect(w.feet.x).toBeCloseTo(-6, 3);
    expect(w.feet.z).toBeCloseTo(-15, 3);
  });

  it("a limit wider than the ground still keeps the walker on it", () => {
    const w = new Walker(collider, { minY: -10, respawn, limit: { center: new THREE.Vector3(0, 0, 0), half: [30, 30] } });
    w.feet.set(0, 0, -15);
    walk(w, 8, west);
    expect(w.feet.x).toBeCloseTo(-20 + 0.4, 3);
    expect(w.onGround).toBe(true);
    expect(w.respawns).toBe(0);
  });
});

describe("streetLevel", () => {
  it("is the most common open-sky ground height", () => {
    // Ground at 0 covers most of the 40 x 40 m plane; the building roof (4 m) and steps are smaller.
    expect(streetLevel(collider)).toBeCloseTo(0, 3);
  });
});

describe("findSpawn", () => {
  const outsideBuilding = (p: THREE.Vector3) => p.x < 5 - 0.4 || p.x > 15 + 0.4 || Math.abs(p.z) > 5 + 0.4;

  it("avoids walls and needs ground", () => {
    const inside = findSpawn(collider, new THREE.Vector3(10, 0, 0), [20, 20])!;
    expect(outsideBuilding(inside)).toBe(true);
    expect(inside.y).toBeCloseTo(0, 3);
    expect(Math.abs(inside.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(inside.z)).toBeLessThanOrEqual(20);
  });

  it("finds ground when started off the ground", () => {
    const off = findSpawn(collider, new THREE.Vector3(30, 0, 0), [20, 20])!;
    expect(off.x).toBeLessThanOrEqual(20);
    expect(off.y).toBeCloseTo(0, 3);
    expect(outsideBuilding(off)).toBe(true);
  });

  it("with maxRise, skips open roofs higher than near.y + maxRise", () => {
    // A bottomless 3 m block standing on nothing but its own top: only its roof is hit from above.
    const root = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40));
    ground.rotation.x = -Math.PI / 2;
    ground.position.x = 30; // ground only for x 10..50
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(20, 40));
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(0, 3, 0); // roof over x -10..10
    root.add(ground, roof);
    const scene = buildCollider(root);
    expect(findSpawn(scene, new THREE.Vector3(0, 0, 0), [60, 60])!.y).toBeCloseTo(3, 3);
    const low = findSpawn(scene, new THREE.Vector3(0, 0, 0), [60, 60], { maxRise: 1.5 })!;
    expect(low.y).toBeCloseTo(0, 3);
    expect(low.x).toBeGreaterThan(10);
  });

  it("returns a clear spot unchanged", () => {
    const clear = findSpawn(collider, new THREE.Vector3(0, 0, -17), [20, 20])!;
    expect(clear.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, -17]);
  });

  it("returns null when nothing qualifies, so the caller can fall back", () => {
    // maxRise below the near point rules out all the ground.
    expect(findSpawn(collider, new THREE.Vector3(0, 0, -17), [20, 20], { maxRise: -1 })).toBeNull();
  });
});
