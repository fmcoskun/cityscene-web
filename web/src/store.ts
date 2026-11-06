import { create } from "zustand";

export type CameraMode = "aerial" | "orbit" | "walk";
/** The walk-mode collision mesh: still loading, built, or failed (walk mode then stays off). */
export type CollisionState = "loading" | "ready" | "failed";
/** The lighting: AksarayCity's daytime and golden hour, and the Blender night scene as exported. */
export type LightMode = "daytime" | "golden_hour" | "night";

interface AppState {
  cameraMode: CameraMode;
  loadProgress: number;
  ready: boolean;
  pointerLocked: boolean;
  collision: CollisionState;
  /** The mode chosen in the HUD. */
  lightMode: LightMode;
  /** The mode the scene shows: it follows lightMode once that mode's sky has loaded (DaylightRig). */
  activeLightMode: LightMode;
  /** A light-mode switch is loading its sky or preparing its shaders. */
  lightModePending: boolean;
  fatalError: string | null;
  setFatalError: (message: string) => void;
  setCameraMode: (mode: CameraMode) => void;
  setLoadProgress: (value: number) => void;
  setReady: () => void;
  setPointerLocked: (locked: boolean) => void;
  setCollision: (collision: CollisionState) => void;
  setLightMode: (mode: LightMode) => void;
  setActiveLightMode: (mode: LightMode) => void;
  setLightModePending: (pending: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  cameraMode: "aerial",
  loadProgress: 0,
  ready: false,
  pointerLocked: false,
  collision: "loading",
  lightMode: "night",
  activeLightMode: "night",
  lightModePending: false,
  fatalError: null,
  setFatalError: (fatalError) => set({ fatalError }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setLoadProgress: (loadProgress) => set({ loadProgress }),
  setReady: () => set({ ready: true }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setCollision: (collision) => set({ collision }),
  setLightMode: (lightMode) => set({ lightMode }),
  setActiveLightMode: (activeLightMode) => set({ activeLightMode }),
  setLightModePending: (lightModePending) => set({ lightModePending }),
}));
