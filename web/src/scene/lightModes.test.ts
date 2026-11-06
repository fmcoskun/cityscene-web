import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SceneData } from "../data/types";
import { applyPreset, bloomFor, chooseSky, LIGHT_MODES, photoRotation, shadowFrustum, sunDirection, type ModeTargets } from "./lightModes";

const BOUNDS: SceneData["bounds"] = { min: [-86.517, -70.153, -2.524], max: [87.689, 69.32, 36.434] };

/** The eight corners of the Blender bounds, in three.js axes. */
function corners(bounds: SceneData["bounds"]) {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) result.push(new THREE.Vector3(x, z, -y));
  return result;
}

function emissive(intensity: number) {
  return new THREE.MeshStandardMaterial({ emissive: "#ff2050", emissiveIntensity: intensity });
}

function targets(): ModeTargets {
  return {
    renderer: { toneMapping: THREE.AgXToneMapping, toneMappingExposure: 1 },
    scene: { fog: null },
    bloom: { strength: 0.15, enabled: true },
    materials: [emissive(5), emissive(8), new THREE.MeshStandardMaterial()],
  };
}

describe("sunDirection", () => {
  it("points straight up at 90 degrees elevation", () => {
    const up = sunDirection(90, 0);
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(1);
    expect(up.z).toBeCloseTo(0);
  });

  it("is a unit vector whose height is the sine of the elevation", () => {
    const sun = sunDirection(50, 145);
    expect(sun.length()).toBeCloseTo(1);
    expect(sun.y).toBeCloseTo(Math.sin((50 * Math.PI) / 180));
  });

  it("turns with Blender's azimuth (0 north = Blender +y = three.js -z, 90 east = +x)", () => {
    const north = sunDirection(0, 0);
    expect(north.z).toBeCloseTo(-1);
    const east = sunDirection(0, 90);
    expect(east.x).toBeCloseTo(1);
    // At 258 degrees the golden-hour sun is in the west.
    expect(sunDirection(9, 258).x).toBeLessThan(-0.9);
  });
});

describe("shadowFrustum", () => {
  it("covers every corner of the scene from the daytime and golden-hour suns", () => {
    const frustum = shadowFrustum(BOUNDS);
    for (const [elevation, azimuth] of [
      [50, 145],
      [9, 258],
      [90, 0],
      [2, 33],
    ]) {
      const direction = sunDirection(elevation, azimuth);
      const camera = new THREE.OrthographicCamera(frustum.left, frustum.right, frustum.top, frustum.bottom, frustum.near, frustum.far);
      camera.position.copy(frustum.center).addScaledVector(direction, frustum.distance);
      camera.lookAt(frustum.center);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      for (const corner of corners(BOUNDS)) {
        const ndc = corner.clone().project(camera);
        expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.z)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is centred on the scene box", () => {
    const { center } = shadowFrustum(BOUNDS);
    expect(center.x).toBeCloseTo((-86.517 + 87.689) / 2);
    expect(center.y).toBeCloseTo((-2.524 + 36.434) / 2);
    expect(center.z).toBeCloseTo(-(-70.153 + 69.32) / 2);
  });
});

describe("LIGHT_MODES", () => {
  it("carries today's night values unchanged", () => {
    const night = LIGHT_MODES.night;
    expect(night.sun).toBeNull();
    expect(night.sky).toBe("night");
    expect(night.toneMapping).toBe("agx");
    expect(night.exposure).toBe(1);
    expect(night.bloomStrength).toEqual({ aerial: 0.15, street: 0.5 });
    expect(night.nightLights).toBe(1);
    expect(night.emissionLevel).toBe(1);
    expect(night.shadows).toBe(false);
    expect(night.fog).toBeUndefined();
    expect(night.hemi.intensity).toBe(0);
  });

  it("puts the suns where the plan says (Blender elevation and azimuth)", () => {
    expect(LIGHT_MODES.daytime.sun).toMatchObject({ elevationDeg: 50, azimuthDeg: 145 });
    expect(LIGHT_MODES.golden_hour.sun).toMatchObject({ elevationDeg: 9, azimuthDeg: 258 });
    expect(LIGHT_MODES.daytime.sky).toBe("photo");
    expect(LIGHT_MODES.golden_hour.sky).toBe("dome");
    expect(LIGHT_MODES.daytime.shadows).toBe(true);
    expect(LIGHT_MODES.golden_hour.shadows).toBe(true);
  });

  it("emission scaled by mode: daytime well under a third, night full", () => {
    expect(LIGHT_MODES.daytime.emissionLevel).toBeLessThan(0.3);
    expect(LIGHT_MODES.night.emissionLevel).toBe(1);
    expect(LIGHT_MODES.golden_hour.emissionLevel).toBeLessThan(1);
  });

  it("every mode that can fall back to the sky dome has dome colours", () => {
    expect(LIGHT_MODES.daytime.dome).toBeDefined();
    expect(LIGHT_MODES.golden_hour.dome).toBeDefined();
    // The photographed sky has no ground below the horizon; PhotoDome draws this colour there.
    expect(LIGHT_MODES.daytime.photo?.ground).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("chooseSky", () => {
  it("day sky failure falls back to sky dome", () => {
    expect(chooseSky("photo", false)).toBe("photo");
    expect(chooseSky("photo", true)).toBe("dome");
    expect(chooseSky("dome", true)).toBe("dome");
    expect(chooseSky("night", true)).toBe("night");
  });
});

describe("bloomFor", () => {
  it("uses the street strength only in walk mode", () => {
    expect(bloomFor(LIGHT_MODES.night, "walk")).toBe(0.5);
    expect(bloomFor(LIGHT_MODES.night, "aerial")).toBe(0.15);
    expect(bloomFor(LIGHT_MODES.night, "orbit")).toBe(0.15);
  });
});

describe("photoRotation", () => {
  it("turns the photo so its sun lands on the wanted direction", () => {
    const photoSun = new THREE.Vector3(Math.cos(0.3), 0.8, Math.sin(0.3)).normalize();
    const wanted = sunDirection(50, 145);
    const turn = photoRotation(photoSun, wanted);
    // The renderer shows the photo's direction d at Ry(turn) * d.
    const shown = photoSun.clone().applyEuler(new THREE.Euler(0, turn, 0));
    expect(Math.atan2(shown.z, shown.x)).toBeCloseTo(Math.atan2(wanted.z, wanted.x));
  });
});

describe("applyPreset", () => {
  it("night values restored after round trip", () => {
    const target = targets();
    const first = applyPreset(target, LIGHT_MODES.night, "aerial");
    applyPreset(target, LIGHT_MODES.daytime, "aerial");
    applyPreset(target, LIGHT_MODES.golden_hour, "aerial");
    applyPreset(target, LIGHT_MODES.daytime, "aerial");
    const again = applyPreset(target, LIGHT_MODES.night, "aerial");
    expect(again).toEqual(first);
    expect(first.emission).toEqual([5, 8, 1]);
    expect(target.renderer.toneMapping).toBe(THREE.AgXToneMapping);
    expect(target.renderer.toneMappingExposure).toBe(1);
    expect(target.scene.fog).toBeNull();
    expect(target.bloom).toEqual({ strength: 0.15, enabled: true });
  });

  it("dims the emission by day without compounding", () => {
    const target = targets();
    const day = applyPreset(target, LIGHT_MODES.daytime, "walk");
    const dayAgain = applyPreset(target, LIGHT_MODES.daytime, "walk");
    expect(dayAgain).toEqual(day);
    expect(day.emission[0]).toBeCloseTo(5 * LIGHT_MODES.daytime.emissionLevel);
    expect(day.toneMapping).toBe(THREE.ACESFilmicToneMapping);
  });
});
