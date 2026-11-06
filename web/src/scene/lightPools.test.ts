import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCollider } from "../lib/walker";
import { LIGHT_RADIUS_M, MAX_POOL_RADIANCE, POOL_ALBEDO, groundPool, localLights, poolFalloff, poolShape } from "./lightPools";

/** A 40 m ground plane at y = 0, a 2 m high slab (its top at y = 2) around x = 10, a thin lamp housing at (0, 5.9, 5). */
function scene() {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2));
  const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4));
  slab.position.set(10, 1, 0);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.6));
  housing.position.set(0, 5.9, 5);
  root.add(ground, slab, housing);
  return buildCollider(root);
}

describe("poolShape", () => {
  it("gives the Lambert radiance under a point light and spreads 2.5 heights", () => {
    const shape = poolShape(5, 5, 1, null, 25);
    expect(shape.shape).toBe("spread");
    expect(shape.radius).toBeCloseTo(12.5);
    expect(shape.radiance).toBeCloseTo(((25 / (25 + 0.25)) * POOL_ALBEDO) / Math.PI);
  });

  it("sizes a narrow spot by its cone and caps the radiance", () => {
    const cone = poolShape(10, 10, 1, Math.PI / 8, 8);
    expect(cone.shape).toBe("cone");
    expect(cone.radius).toBeCloseTo(10 * Math.tan(Math.PI / 8) * 1.05);
    expect(poolShape(1, 1, 1, null, 1e4).radiance).toBe(MAX_POOL_RADIANCE);
  });

  it("a hemisphere (area) light spreads, and dims with the cosine of its tilt", () => {
    const straight = poolShape(4, 4, 1, Math.PI / 2, 10);
    const slanted = poolShape(4, 4, 0.6, Math.PI / 2, 10);
    expect(straight.shape).toBe("spread");
    expect(slanted.radiance).toBeCloseTo(straight.radiance * 0.6);
  });
});

describe("poolFalloff", () => {
  it("spread: the floor under a point light, (1 + u^2)^-3/2, from 1 at the centre to 0 at the edge", () => {
    expect(poolFalloff(0)).toBeCloseTo(1);
    expect(poolFalloff(1)).toBeCloseTo(0);
    const edge = 7.25 ** -1.5;
    expect(poolFalloff(0.4)).toBeCloseTo((2 ** -1.5 - edge) / (1 - edge));
  });

  it("cone: flat inside, a soft rim over the outer fifth", () => {
    expect(poolFalloff(0.5, "cone")).toBe(1);
    expect(poolFalloff(0.9, "cone")).toBeCloseTo(0.5);
    expect(poolFalloff(1, "cone")).toBe(0);
  });
});

describe("groundPool", () => {
  const collider = scene();

  it("finds the ground under a lamp", () => {
    const pool = groundPool(collider, new THREE.Vector3(0, 6, 0), null, null, 30);
    expect(pool?.center.y).toBeCloseTo(0.05);
    expect(pool?.radius).toBeCloseTo(15);
  });

  it("lands on a roof top under the light, and skips the lamp's own housing", () => {
    expect(groundPool(collider, new THREE.Vector3(0, 6, 5), null, null, 30)?.center.y).toBeCloseTo(0.05);
    expect(groundPool(collider, new THREE.Vector3(10, 5, 0), null, null, 30)?.center.y).toBeCloseTo(2.05);
  });

  it("follows a downward spot along its axis, dimmed by the tilt", () => {
    const tilted = new THREE.Vector3(1, -2, 0).normalize();
    const pool = groundPool(collider, new THREE.Vector3(-10, 4, 0), tilted, 0.5, 30)!;
    expect(pool.center.x).toBeCloseTo(-8);
    expect(pool.shape).toBe("cone");
    const distance = Math.hypot(2, 4);
    expect(pool.radiance).toBeCloseTo(((30 * (2 / Math.sqrt(5))) / (distance * distance + 0.25)) * (POOL_ALBEDO / Math.PI));
  });

  it("gives no pool to a spot or area light aimed more than 60 degrees from straight down", () => {
    const sideways = new THREE.Vector3(1, -0.13, 0).normalize();
    expect(groundPool(collider, new THREE.Vector3(-10, 4, 0), sideways, Math.PI / 2, 30)).toBeNull();
    const at61 = new THREE.Vector3(Math.sin((61 * Math.PI) / 180), -Math.cos((61 * Math.PI) / 180), 0);
    expect(groundPool(collider, new THREE.Vector3(-10, 4, 0), at61, 0.5, 30)).toBeNull();
    const at50 = new THREE.Vector3(Math.sin((50 * Math.PI) / 180), -Math.cos((50 * Math.PI) / 180), 0);
    expect(groundPool(collider, new THREE.Vector3(-10, 4, 0), at50, 0.5, 30)).not.toBeNull();
  });
});

describe("localLights", () => {
  it("keeps point and spot lights and leaves sun lights out", () => {
    const lights = [
      { name: "Lamp", kind: "point" as const },
      { name: "Spot", kind: "spot" as const },
      { name: "Sun", kind: "sun" as const },
    ];
    expect(localLights(lights).map((light) => light.name)).toEqual(["Lamp", "Spot"]);
  });
});

describe("LIGHT_RADIUS_M", () => {
  it("is the soft radius in the pool irradiance I * cos / (d^2 + r^2)", () => {
    const shape = poolShape(1, 1, 1, null, 1);
    expect(shape.radiance).toBeCloseTo(((1 / (1 + LIGHT_RADIUS_M ** 2)) * POOL_ALBEDO) / Math.PI);
  });
});
