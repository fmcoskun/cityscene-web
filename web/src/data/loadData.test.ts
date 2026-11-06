import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSceneData } from "./loadData";

function sceneJson(): Record<string, unknown> {
  return {
    source: { blend: "CityScene.blend", mtime: 0, exported: "2026-11-05T00:00:00+00:00" },
    bounds: { min: [-1, -1, 0], max: [1, 1, 2] },
    cameras: {
      center: [0, 0, 1],
      aerial: { position: [0, -10, 10], min: 10, max: 100 },
      orbit: { position: [-10, -10, 5], min: 10, max: 100 },
      limit: [1, 1],
    },
    lights: [{ name: "Area", pos: [0, 0, 3], dir: null, kind: "point", color: [1, 1, 1], intensity: 10, angle: null, source: "AREA" }],
    sky: { file: null, rotation_z: 0, strength: 1 },
    materials: { NEON: "override" },
    overrides: { NEON: { type: "emissive", color: "#ff0000", emissive: "#ff0000", emissiveIntensity: 2, roughness: 0.5, metalness: 0 } },
    stats: { triangles: 12, collision_triangles: 12, objects: 1, collision_objects: [] },
    warnings: [],
  };
}

function serve(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe("loadSceneData", () => {
  it("loadSceneData tolerates missing sky", async () => {
    serve(sceneJson());
    const data = await loadSceneData();
    expect(data.sky.file).toBeNull();
    expect(data.lights).toHaveLength(1);
  });

  it("names the lights field when it is missing", async () => {
    const body = sceneJson();
    delete body.lights;
    serve(body);
    await expect(loadSceneData()).rejects.toThrow(/lights/);
  });

  it("reports an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(loadSceneData()).rejects.toThrow(/404/);
  });
});
