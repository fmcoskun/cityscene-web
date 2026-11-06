// The shape of web/public/data/scene.json, written by blender/export_scene.py.
// Positions and directions are Blender coordinates (z up); convert with lib/coords toWorld.

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];

export interface LightData {
  name: string;
  pos: Vec3;
  /** Unit direction the light points along, for spot (and area) and sun lights; null for point lights. */
  dir: Vec3 | null;
  kind: "point" | "spot" | "sun";
  color: Rgb;
  intensity: number;
  /** Half cone angle in radians for spot lights (Blender spot_size / 2, as three.js SpotLight.angle); null otherwise. */
  angle: number | null;
  /** Spot penumbra (Blender spot_blend; 1 for area lights, whose falloff stands in for the cosine); null for point lights. */
  blend?: number | null;
  /** The Blender light type it came from (POINT, SPOT, AREA, SUN). */
  source: string;
}

export interface MaterialOverride {
  type: "emissive" | "glass";
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  roughness: number;
  metalness: number;
  opacity?: number;
  transmission?: number;
  _note?: string;
}

export interface CameraFrame {
  position: Vec3;
  min: number;
  max: number;
}

export interface SceneData {
  source: { blend: string; mtime: number; exported: string };
  bounds: { min: Vec3; max: Vec3 };
  cameras: {
    center: Vec3;
    aerial: CameraFrame;
    orbit: CameraFrame;
    /** Half extents of the walkable plan area around the centre, in metres. */
    limit: [number, number];
  };
  lights: LightData[];
  sky: { file: string | null; rotation_z: number; strength: number };
  materials: Record<string, "override" | "gltf" | "bake">;
  overrides: Record<string, MaterialOverride>;
  stats: {
    triangles: number;
    collision_triangles: number;
    objects: number;
    collision_objects: string[];
    bake_count?: number;
    bake_cached?: number;
    bake_unused?: string[];
    bake_tiled?: string[];
    bake_alpha?: string[];
    bake_emissive?: string[];
  };
  warnings: string[];
}
