import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MaterialOverride } from "../data/types";
import { applyOverrides, buildOverrideMaterial, scaleEmission } from "./materials";

const NEON: MaterialOverride = { type: "emissive", color: "#ff2050", emissive: "#ff2050", emissiveIntensity: 4, roughness: 0.5, metalness: 0 };
const GLASS: MaterialOverride = { type: "glass", color: "#ffffff", opacity: 0.3, roughness: 0.1, metalness: 0, transmission: 1 };

function mesh(materialName: string) {
  const material = new THREE.MeshStandardMaterial();
  material.name = materialName;
  return new THREE.Mesh(new THREE.BoxGeometry(), material);
}

describe("buildOverrideMaterial", () => {
  it("builds a glowing standard material for an emissive override", () => {
    const material = buildOverrideMaterial("NEON", NEON);
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.emissive.getHexString()).toBe("ff2050");
    expect(material.emissiveIntensity).toBe(4);
    expect(material.toneMapped).toBe(true);
    expect(material.name).toBe("NEON");
  });

  it("builds a see-through physical material for a glass override", () => {
    const material = buildOverrideMaterial("GLASS", GLASS) as THREE.MeshPhysicalMaterial;
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.opacity).toBeCloseTo(0.3);
    expect(material.transmission).toBe(1);
    expect(material.roughness).toBeCloseTo(0.1);
  });
});

describe("applyOverrides", () => {
  it("replaces only the material whose name matches and counts it", () => {
    const root = new THREE.Group();
    const neon = mesh("NEON");
    const brick = mesh("Brick");
    const brickMaterial = brick.material;
    root.add(neon, brick);
    expect(applyOverrides(root, { NEON })).toBe(1);
    expect((neon.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("ff2050");
    expect(brick.material).toBe(brickMaterial);
  });

  it("matches the base name before an @object or .NNN suffix only when the base is an override key", () => {
    const root = new THREE.Group();
    const perObject = mesh("NEON@Sign.002");
    const numbered = mesh("NEON.004");
    const exactNumbered = mesh("NEON STRIP.001");
    const unrelated = mesh("Brick@Wall");
    const unrelatedMaterial = unrelated.material;
    root.add(perObject, numbered, exactNumbered, unrelated);
    const strip: MaterialOverride = { ...NEON, emissive: "#00ff00" };
    expect(applyOverrides(root, { NEON, "NEON STRIP.001": strip })).toBe(3);
    expect((perObject.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("ff2050");
    expect((numbered.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("ff2050");
    // An exact key wins over its base name.
    expect((exactNumbered.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("00ff00");
    expect(unrelated.material).toBe(unrelatedMaterial);
  });

  it("handles meshes with several materials and shares one built material per override", () => {
    const root = new THREE.Group();
    const a = mesh("NEON");
    const b = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial({ name: "Brick" }), new THREE.MeshStandardMaterial({ name: "NEON" })]);
    root.add(a, b);
    expect(applyOverrides(root, { NEON })).toBe(2);
    const list = b.material as THREE.Material[];
    expect(list[0].name).toBe("Brick");
    expect(list[1]).toBe(a.material);
  });
});

describe("scaleEmission", () => {
  it("scales overridden and baked (emissive strength) materials from their original intensity, never compounding", () => {
    const neon = buildOverrideMaterial("NEON", NEON) as THREE.MeshStandardMaterial;
    // A baked copy as GLTFLoader builds it from KHR_materials_emissive_strength.
    const baked = new THREE.MeshStandardMaterial({ emissive: "#ffffff", emissiveIntensity: 12 });
    const glass = buildOverrideMaterial("GLASS", GLASS);
    scaleEmission([neon, baked, glass, neon], 0.1);
    expect(neon.emissiveIntensity).toBeCloseTo(0.4);
    expect(baked.emissiveIntensity).toBeCloseTo(1.2);
    scaleEmission([neon, baked], 0.5);
    expect(neon.emissiveIntensity).toBeCloseTo(2);
    scaleEmission([neon, baked], 1);
    expect(neon.emissiveIntensity).toBe(4);
    expect(baked.emissiveIntensity).toBe(12);
  });
});
