import { describe, expect, it } from "vitest";
import { useApp } from "./store";

describe("store", () => {
  it("starts in aerial mode, not ready, zero progress", () => {
    const s = useApp.getState();
    expect(s.cameraMode).toBe("aerial");
    expect(s.ready).toBe(false);
    expect(s.loadProgress).toBe(0);
  });
  it("switches camera mode", () => {
    useApp.getState().setCameraMode("walk");
    expect(useApp.getState().cameraMode).toBe("walk");
  });
  it("tracks the collision data: loading, then ready or failed", () => {
    expect(useApp.getState().collision).toBe("loading");
    useApp.getState().setCollision("failed");
    expect(useApp.getState().collision).toBe("failed");
  });
  it("has dropped the AksarayCity-only fields", () => {
    const s = useApp.getState();
    for (const key of ["layers", "showLabels", "hovered", "selected"]) expect(key in s).toBe(false);
  });
  it("opens at night; the shown mode follows a requested one only when told", () => {
    const s = useApp.getState();
    expect(s.lightMode).toBe("night");
    expect(s.activeLightMode).toBe("night");
    expect(s.lightModePending).toBe(false);
    s.setLightMode("daytime");
    expect(useApp.getState().lightMode).toBe("daytime");
    expect(useApp.getState().activeLightMode).toBe("night");
    useApp.getState().setActiveLightMode("daytime");
    expect(useApp.getState().activeLightMode).toBe("daytime");
  });
});
