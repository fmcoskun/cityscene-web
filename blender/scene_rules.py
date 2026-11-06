"""Pure export rules (stdlib only, no bpy). Coordinates are Blender coordinates (z up)."""
import json
import math

REQUIRED_KEYS = (
    "blend", "scene", "exclude_objects", "disable_modifiers",
    "texture_max_px", "bake_px", "collision", "overrides_file",
)

BAKE_NODE_TYPES = frozenset({
    "GROUP", "MIX_SHADER", "ADD_SHADER", "TEX_NOISE", "TEX_BRICK",
    "TEX_VORONOI", "TEX_WAVE", "VALTORGB",
})

def load_config(path):
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for key in REQUIRED_KEYS:
        if key not in cfg:
            raise KeyError("missing required config key: %s" % key)
    return cfg


def classify_material(summary, overrides):
    """Return "override", "gltf" or "bake"."""
    if summary["name"] in overrides:
        return "override"
    if summary["surface"] == "BSDF_PRINCIPLED" and not BAKE_NODE_TYPES.intersection(summary["node_types"]):
        return "gltf"
    return "bake"


def light_to_web(kind, energy_w, color, spot_size, spot_blend=None):
    """Convert a Blender light to web light data.

    Intensity is radiant intensity in Blender's own scene-linear units (W/sr), which three.js
    lights take as their "candela": three shades a Lambert surface as albedo/pi * I/d^2 * cos, the
    same as Cycles/EEVEE do with I in W/sr, so the two match at a light scale of 1. There is no
    683 lm/W factor: Blender's watts are not converted to photometric units anywhere in its
    renderers, so applying one made every light 683 times too bright on the web.

    - POINT: P watts in all directions, I = P / 4pi.
    - SPOT: Blender's spot power is that of the point light the cone is cut from, I = P / 4pi;
      angle = spot_size / 2 (three.js SpotLight.angle), blend = spot_blend (as penumbra).
    - AREA: a one-sided Lambertian emitter, I(theta) = (P / pi) cos(theta) about its -Z axis.
      It becomes a spot over the hemisphere (angle pi/2) with I = P / pi on the axis and blend 1,
      whose smooth falloff from the axis to 90 degrees stands in for the cosine.
    - SUN: kind "sun", intensity = the sun strength (irradiance in W/m^2, as three.js
      DirectionalLight.intensity), no angle or blend. The web app does not draw sun lights (a
      night scene's nearest-light pool cannot stand for one); the exporter warns about each.
    """
    if kind == "SUN":
        return {"kind": "sun", "color": [color[0], color[1], color[2]], "intensity": energy_w,
                "angle": None, "blend": None}
    if kind == "AREA":
        return {"kind": "spot", "color": [color[0], color[1], color[2]], "intensity": energy_w / math.pi,
                "angle": math.pi / 2, "blend": 1.0}
    spot = kind == "SPOT"
    return {
        "kind": "spot" if spot else "point",
        "color": [color[0], color[1], color[2]],
        "intensity": energy_w / (4 * math.pi),
        "angle": spot_size / 2 if spot and spot_size is not None else None,
        "blend": spot_blend if spot and spot_blend is not None else (0.0 if spot else None),
    }


def collides(name, size, config):
    col = config["collision"]
    if max(size) < col["min_size_m"]:
        return False
    return not any(name.startswith(p) for p in col["exclude"])


def frame_cameras(bounds_min, bounds_max):
    """Camera placement from scene bounds.

    center = bounds midpoint; diag = length of the bounds box diagonal.
    aerial: position = center + (0, -d*cos40, d*sin40) with d = diag*1.1,
      i.e. looking down at 40 degrees; since d*sin40 ~ 0.7*diag this clears the top.
      The z is also forced above bounds_max z. Distance limits: min 10, max diag*3.
    orbit: lower 3/4 view: d = diag*0.9, 20 degrees elevation, offset along (-x, -y) diagonal.
    limit = half extent in x/y + 2 m.
    """
    center = [(a + b) / 2 for a, b in zip(bounds_min, bounds_max)]
    ext = [b - a for a, b in zip(bounds_min, bounds_max)]
    diag = math.sqrt(sum(e * e for e in ext))
    tilt = math.radians(40)
    d = diag * 1.1
    az = max(center[2] + d * math.sin(tilt), bounds_max[2] + 1.0)
    aerial_pos = [center[0], center[1] - d * math.cos(tilt), az]
    elev = math.radians(20)
    d2 = diag * 0.9
    h = d2 * math.cos(elev) / math.sqrt(2)
    orbit_pos = [center[0] - h, center[1] - h, center[2] + d2 * math.sin(elev)]
    limits = {"min": 10, "max": diag * 3}
    return {
        "center": center,
        "aerial": {"position": aerial_pos, **limits},
        "orbit": {"position": orbit_pos, **limits},
        "limit": [ext[0] / 2 + 2, ext[1] / 2 + 2],
    }
