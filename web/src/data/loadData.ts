import type { SceneData } from "./types";

const base = import.meta.env.BASE_URL;

/** Top-level fields the app cannot run without. A missing one names itself in the error. */
const REQUIRED: (keyof SceneData)[] = ["bounds", "cameras", "lights", "sky", "materials", "overrides"];

export async function loadSceneData(): Promise<SceneData> {
  const path = "data/scene.json";
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`${path} yüklenemedi (HTTP ${response.status})`);
  const data = (await response.json()) as Partial<SceneData>;
  const missing = REQUIRED.filter((key) => data[key] == null);
  if (missing.length) throw new Error(`${path} eksik alan: ${missing.join(", ")}`);
  return data as SceneData;
}

export function assetUrl(path: string): string {
  return base + path;
}
