import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { loadSkyOrNull } from "./skyTexture";

describe("loadSkyOrNull", () => {
  it("returns the loaded texture", async () => {
    const texture = new THREE.Texture();
    expect(await loadSkyOrNull(async () => texture, "sky.hdr")).toBe(texture);
  });

  it("falls back to null when the sky fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadSkyOrNull(async () => {
      throw new Error("HTTP 404");
    }, "sky.hdr");
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
