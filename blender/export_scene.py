"""Export the CityScene night city for the web app.

    blender --background --factory-startup --python blender/export_scene.py -- \
        --config config/export_config.json --out web/public [--no-bake] [--bake-cache DIR]

Writes under --out: models/city.glb, models/collision.glb, data/scene.json, textures/sky.hdr.
"bake" materials are baked to textures (blender/bake.py) unless --no-bake; baked PNGs are cached
in --bake-cache (default blender/cache/bake/) and reused while material, object and mesh match.
All scene edits happen in memory; the source .blend is never saved. Files are written to a
temporary sibling of --out and moved in only when the whole run succeeds. The last stdout line is
"CS_EXPORT_OK <stats JSON>"; on failure the process exits with code 1.
"""
import argparse
import datetime
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time

import bpy
import numpy as np
from mathutils import Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import scene_rules  # noqa: E402

COLLISION_NAME = "CS_Collision"


def _resolve(path, *bases):
    if os.path.isabs(path):
        return path
    for base in bases:
        candidate = os.path.join(base, path)
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return os.path.abspath(os.path.join(bases[-1], path))


def _r(values, nd=4):
    return [round(float(v), nd) for v in values]


# --- scene preparation -------------------------------------------------------------------------

def open_scene(cfg):
    bpy.ops.wm.open_mainfile(filepath=cfg["blend"], load_ui=False)
    scene = bpy.data.scenes.get(cfg["scene"])
    if scene is None:
        raise KeyError("scene not found in blend: %s" % cfg["scene"])
    for window in bpy.context.window_manager.windows:
        window.scene = scene
    for other in [s for s in bpy.data.scenes if s != scene]:
        bpy.data.scenes.remove(other)
    return scene


def exclude_objects(cfg, warnings):
    """Delete each excluded object together with its whole child subtree (in memory only)."""
    for name in cfg["exclude_objects"]:
        obj = bpy.data.objects.get(name)
        if obj is None:
            warnings.append("exclude_objects: no object named %s" % name)
            continue
        for victim in [obj] + list(obj.children_recursive):
            bpy.data.objects.remove(victim, do_unlink=True)


def disable_modifiers(scene, types):
    count = 0
    for obj in scene.objects:
        for mod in obj.modifiers:
            if mod.type in types:
                mod.show_viewport = False
                mod.show_render = False
                count += 1
    return count


def apply_render_visibility(scene, view_layer):
    """Ruling R19, one visibility rule for the visual export, collision and the scene bounds:
    what Blender renders is exported. Objects disabled for render (their own camera icon, or no
    collection path from the scene to them that is neither render-disabled nor excluded from the
    view layer) are marked hide_render, which export_visual (use_renderable), mesh_instances and
    collect_lights all skip. Objects hidden only in the viewport (eye icon, monitor icon, on the
    object or its collections) are unhidden, in memory, so the depsgraph draws them too. Objects
    of collections that some object instances are left alone (they are drawn through the instance).
    Returns (render-disabled names, unhidden names)."""
    instanced = set()
    for obj in bpy.data.objects:
        if obj.instance_type == "COLLECTION" and obj.instance_collection is not None:
            instanced.update(obj.instance_collection.all_objects)
    rendered = set()

    def walk(layer, enabled, root):
        coll = layer.collection
        if not root:
            enabled = enabled and not layer.exclude and not coll.hide_render
            layer.hide_viewport = False
            coll.hide_viewport = False
        if enabled:
            rendered.update(coll.objects)
        for child in layer.children:
            walk(child, enabled, False)

    walk(view_layer.layer_collection, True, True)
    disabled, unhidden = [], []
    for obj in scene.objects:
        if obj in instanced and obj not in rendered:
            continue
        if obj.hide_render or obj not in rendered:
            obj.hide_render = True
            disabled.append(obj.name)
        elif obj.hide_viewport or obj.hide_get(view_layer=view_layer):
            obj.hide_viewport = False
            obj.hide_set(False, view_layer=view_layer)
            unhidden.append(obj.name)
    return sorted(disabled), sorted(unhidden)


def collect_lights(scene, warnings):
    """Light data in Blender world coordinates; `dir` (spot, area and sun lights) is the light's
    world -Z axis. Render-disabled lights are left out."""
    lights = []
    for obj in sorted((o for o in scene.objects if o.type == "LIGHT" and not o.hide_render), key=lambda o: o.name):
        data = obj.data
        world = obj.matrix_world
        spot = data.type == "SPOT"
        light = scene_rules.light_to_web(data.type, data.energy, tuple(data.color),
                                         data.spot_size if spot else None, data.spot_blend if spot else None)
        direction = None
        if light["kind"] in ("spot", "sun"):
            direction = _r((world.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized())
        if light["kind"] == "sun":
            warnings.append("sun light %s: exported as kind sun, which the web app does not draw" % obj.name)
        lights.append({
            "name": obj.name,
            "pos": _r(world.translation),
            "dir": direction,
            "kind": light["kind"],
            "color": _r(light["color"]),
            "intensity": round(light["intensity"], 4),
            "angle": None if light["angle"] is None else round(light["angle"], 5),
            "blend": None if light["blend"] is None else round(light["blend"], 4),
            "source": data.type,
        })
    return lights


def delete_lights(scene):
    for obj in [o for o in scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(obj, do_unlink=True)


# --- materials ---------------------------------------------------------------------------------

def _surface_type(mat):
    tree = mat.node_tree
    if tree is None:
        return None
    outputs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"]
    active = [n for n in outputs if n.is_active_output] or outputs
    if not active:
        return None
    sock = active[0].inputs.get("Surface")
    if sock is None or not sock.is_linked:
        return None
    return sock.links[0].from_node.type


def material_summary(mat):
    tree = mat.node_tree
    return {"name": mat.name, "surface": _surface_type(mat),
            "node_types": sorted({n.type for n in tree.nodes}) if tree else []}


def used_materials(scene):
    mats = {}
    for obj in scene.objects:
        if obj.type != "MESH" or obj.hide_render:  # render-disabled objects are not exported
            continue
        for slot in obj.material_slots:
            if slot.material is not None:
                mats[slot.material.name] = slot.material
    return mats


def _hex_to_linear(value, default=(0.8, 0.8, 0.8)):
    if not value:
        return default
    value = value.lstrip("#")
    srgb = [int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def apply_placeholder(mat, override):
    """Replace the node tree with a plain Principled BSDF; the web app rebuilds it by name from
    the override alone, so no texture is kept (it would only add bytes the web never reads)."""
    tree = mat.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (*_hex_to_linear(override.get("color")), 1.0)
    bsdf.inputs["Roughness"].default_value = float(override.get("roughness", 0.5))
    bsdf.inputs["Metallic"].default_value = float(override.get("metalness", 0.0))
    if override.get("emissive"):
        bsdf.inputs["Emission Color"].default_value = (*_hex_to_linear(override["emissive"]), 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(override.get("emissiveIntensity", 1.0))
    if override["type"] == "glass":
        bsdf.inputs["Transmission Weight"].default_value = float(override.get("transmission", 1.0))
        bsdf.inputs["Alpha"].default_value = float(override.get("opacity", 1.0))


def classify_materials(scene, overrides):
    classes = {}
    for name, mat in sorted(used_materials(scene).items()):
        classes[name] = scene_rules.classify_material(material_summary(mat), overrides)
        if classes[name] == "override":
            apply_placeholder(mat, overrides[name])
    return classes


def bake_step(cfg, scene, classes, args, warnings):
    """Bake every 'bake' material, per (object, material), to a texture before the glTF export."""
    names = {name for name, c in classes.items() if c == "bake"}
    empty = {"bake_count": 0, "bake_cached": 0, "bake_seconds": 0.0, "bake_unused": [],
             "bake_tiled": [], "bake_alpha": [], "bake_emissive": []}
    if args.no_bake or not names:
        return empty
    import bake  # bpy-heavy; only needed when baking

    for obj in scene.objects:
        if obj.type != "MESH" and any(s.material is not None and s.material.name in names
                                      for s in getattr(obj, "material_slots", [])):
            warnings.append("bake: %s object %s keeps procedural materials" % (obj.type, obj.name))
    started = time.perf_counter()
    stats = {}
    done = bake.bake_materials([o for o in scene.objects if o.type == "MESH" and not o.hide_render], names, int(cfg["bake_px"]),
                               _resolve(args.bake_cache, os.getcwd(), PROJECT_ROOT), stats=stats,
                               warnings=warnings, log=lambda msg: print("CS_BAKE " + msg, flush=True),
                               max_px=int(cfg["texture_max_px"]))
    baked_names = {key.split("/", 1)[1] for key in done}
    for name in sorted(names - baked_names - set(stats["unused"])):
        warnings.append("bake: material %s was not baked" % name)
    for pair in stats["pairs"]:
        print("CS_BAKE_PAIR " + json.dumps(pair, ensure_ascii=False), flush=True)
    return {"bake_count": len(done), "bake_cached": stats["cached"],
            "bake_seconds": round(time.perf_counter() - started, 1),
            "bake_unused": stats["unused"], "bake_tiled": stats["tiled"],
            "bake_alpha": stats["alpha"], "bake_emissive": stats["emissive"]}


# --- images ------------------------------------------------------------------------------------

def check_images(warnings):
    for img in bpy.data.images:
        if img.source != "FILE" or img.packed_file is not None:
            continue
        path = bpy.path.abspath(img.filepath)
        if not os.path.exists(path):
            warnings.append("missing image: %s (%s)" % (img.name, img.filepath))


def limit_textures(max_px, skip):
    """Scale oversized images down in memory so the GLB carries at most max_px textures."""
    scaled = 0
    for img in bpy.data.images:
        if img in skip or img.source != "FILE":
            continue
        w, h = img.size  # reading size loads the image; missing files report 0 x 0
        if max(w, h) > max_px:
            fmt = img.file_format
            k = max_px / float(max(w, h))
            img.scale(max(1, int(round(w * k))), max(1, int(round(h * k))))
            if fmt == "JPEG":
                img.file_format = "JPEG"  # the exporter's AUTO mode then writes JPEG, not PNG
            scaled += 1
    return scaled


# --- sky ---------------------------------------------------------------------------------------

def _world_env(scene):
    world = scene.world
    if world is None or world.node_tree is None:
        return None, None, None
    env = mapping = background = None
    for node in world.node_tree.nodes:
        if node.type == "TEX_ENVIRONMENT":
            env = node
        elif node.type == "MAPPING":
            mapping = node
        elif node.type == "BACKGROUND":
            background = node
    return env, mapping, background


def export_sky(scene, out_dir, max_px, warnings):
    env, mapping, background = _world_env(scene)
    sky = {"file": None, "rotation_z": 0.0, "strength": 1.0}
    if mapping is not None:
        sky["rotation_z"] = round(float(mapping.inputs["Rotation"].default_value[2]), 5)
    if background is not None:
        sky["strength"] = round(float(background.inputs["Strength"].default_value), 5)
    image = env.image if env is not None else None
    if image is None:
        warnings.append("sky: world has no Environment Texture image")
        return sky, None
    os.makedirs(os.path.join(out_dir, "textures"), exist_ok=True)
    ext = os.path.splitext(image.filepath or image.name)[1].lower().lstrip(".")
    is_hdr = image.file_format in ("OPEN_EXR", "HDR") or ext in ("exr", "hdr")
    tmp_path = None
    try:
        if image.packed_file is not None:
            tmp_dir = tempfile.mkdtemp(prefix="cs_sky_")
            tmp_path = os.path.join(tmp_dir, "sky_src." + ({"OPEN_EXR": "exr", "HDR": "hdr"}.get(image.file_format) or ext or "img"))
            with open(tmp_path, "wb") as fh:
                fh.write(image.packed_file.data)
            src_path = tmp_path
        else:
            src_path = bpy.path.abspath(image.filepath)
            if not os.path.exists(src_path):
                warnings.append("sky: environment image not found: %s" % image.filepath)
                return sky, None
        if not is_hdr:
            rel = "textures/sky." + (ext or "png")
            with open(src_path, "rb") as src, open(os.path.join(out_dir, rel), "wb") as dst:
                dst.write(src.read())
            sky["file"] = rel
            return sky, list(image.size)
        work = bpy.data.images.load(src_path, check_existing=False)
        w, h = work.size
        if max(w, h) > max_px:
            k = max_px / float(max(w, h))
            work.scale(max(1, int(round(w * k))), max(1, int(round(h * k))))
        rel = "textures/sky.hdr"
        work.file_format = "HDR"
        work.filepath_raw = os.path.join(out_dir, rel)
        work.save()
        size = list(work.size)
        bpy.data.images.remove(work)
        with open(os.path.join(out_dir, rel), "rb") as fh:
            if not fh.read(10).startswith(b"#?"):
                raise RuntimeError("written sky.hdr is not a Radiance file")
        sky["file"] = rel
        return sky, size
    except Exception as exc:  # the sky is optional: warn and go on
        warnings.append("sky: could not export environment image %s: %s" % (image.name, exc))
        sky["file"] = None
        return sky, None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
            os.rmdir(os.path.dirname(tmp_path))


# --- geometry ----------------------------------------------------------------------------------

def mesh_instances(depsgraph):
    """Yield (source object name, evaluated object, world matrix) for every mesh drawn, including
    Geometry Nodes / dupli instances. Render-disabled sources are skipped; after
    apply_render_visibility that is the same set export_visual leaves out (ruling R19), and
    viewport-hidden objects have been unhidden, so they are here. The yielded evaluated object is
    only valid inside the loop body."""
    for inst in depsgraph.object_instances:
        ev = inst.object
        if ev.type != "MESH":
            continue
        source = (inst.parent if inst.is_instance else ev).original
        if source.name == COLLISION_NAME or source.hide_render:
            continue
        yield source.name, ev, inst.matrix_world.copy()


def scene_bounds(depsgraph):
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for _name, ev, world in mesh_instances(depsgraph):
        for corner in ev.bound_box:
            p = world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return _r(lo, 3), _r(hi, 3)


def glb_json(path):
    with open(path, "rb") as fh:
        fh.read(12)
        length, kind = struct.unpack("<I4s", fh.read(8))
        if kind != b"JSON":
            raise RuntimeError("GLB without JSON chunk: %s" % path)
        return json.loads(fh.read(length).decode("utf-8"))


def glb_triangles(path):
    """Triangles drawn by the GLB: per node, its mesh's indexed triangle primitives."""
    doc = glb_json(path)
    accessors = doc.get("accessors", [])
    per_mesh = []
    for mesh in doc.get("meshes", []):
        tris = 0
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            if "indices" in prim:
                tris += accessors[prim["indices"]]["count"] // 3
            else:
                tris += accessors[prim["attributes"]["POSITION"]]["count"] // 3
        per_mesh.append(tris)
    return sum(per_mesh[n["mesh"]] for n in doc.get("nodes", []) if "mesh" in n), doc


def build_collision(scene, depsgraph, cfg):
    """One triangle mesh, world space, from the visible evaluated meshes (instances included) of
    colliding objects; no materials or UVs."""
    coords, tris, used, skipped = [], [], set(), set()
    offset = 0
    for name, ev, world in mesh_instances(depsgraph):
        if not scene_rules.collides(name, tuple(ev.dimensions), cfg):
            skipped.add(name)
            continue
        mesh = ev.to_mesh()
        try:
            mesh.calc_loop_triangles()
            nv, nt = len(mesh.vertices), len(mesh.loop_triangles)
            if nt == 0:
                continue
            co = np.empty(nv * 3, dtype=np.float32)
            mesh.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            m = np.array(world, dtype=np.float64)
            co = (co @ m[:3, :3].T + m[:3, 3]).astype(np.float32)
            idx = np.empty(nt * 3, dtype=np.int32)
            mesh.loop_triangles.foreach_get("vertices", idx)
            coords.append(co)
            tris.append(idx + offset)
            offset += nv
            used.add(name)
        finally:
            ev.to_mesh_clear()
    co = np.concatenate(coords) if coords else np.zeros((0, 3), dtype=np.float32)
    idx = np.concatenate(tris) if tris else np.zeros(0, dtype=np.int32)
    nt = len(idx) // 3
    mesh = bpy.data.meshes.new(COLLISION_NAME)
    mesh.vertices.add(len(co))
    mesh.vertices.foreach_set("co", co.ravel())
    mesh.loops.add(len(idx))
    mesh.loops.foreach_set("vertex_index", idx)
    mesh.polygons.add(nt)
    mesh.polygons.foreach_set("loop_start", np.arange(0, len(idx), 3, dtype=np.int32))
    mesh.update(calc_edges=True)
    if mesh.validate(clean_customdata=False):
        nt = len(mesh.polygons)  # validate() dropped degenerate faces
    obj = bpy.data.objects.new(COLLISION_NAME, mesh)
    scene.collection.objects.link(obj)
    return obj, nt, sorted(used), sorted(skipped - used)


def export_visual(path):
    # use_renderable drops objects marked hide_render (apply_render_visibility marks every
    # render-disabled one); use_visible stays off, as viewport-hidden objects render in Blender.
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=False, use_renderable=True, use_visible=False,
        export_apply=True,
        export_lights=False, export_cameras=False, export_yup=True, export_image_format="AUTO",
        export_draco_mesh_compression_enable=False)


def export_collision(scene, obj, path):
    view_layer = scene.view_layers[0]
    for other in scene.objects:
        other.select_set(False, view_layer=view_layer)
    obj.select_set(True, view_layer=view_layer)
    view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=False,
        export_lights=False, export_cameras=False, export_yup=True, export_materials="NONE",
        export_normals=False, export_texcoords=False, export_tangents=False,
        export_attributes=False, export_draco_mesh_compression_enable=False)


# --- main --------------------------------------------------------------------------------------

def publish(stage, out):
    """Move every staged file into --out, replacing what is there; only called after success."""
    for root, _dirs, files in os.walk(stage):
        for name in files:
            src = os.path.join(root, name)
            dst = os.path.join(out, os.path.relpath(src, stage))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)


def run(args):
    """Export into a temporary sibling of --out and move the files into --out only on success,
    so a failed run never leaves a mix of old and new files behind."""
    target = os.path.abspath(args.out)
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    stage = tempfile.mkdtemp(prefix=".cs_export_", dir=parent)
    try:
        report = export_all(args, stage)
        publish(stage, target)
        return report
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def export_all(args, out):
    started = time.perf_counter()
    config_path = _resolve(args.config, os.getcwd(), PROJECT_ROOT)
    cfg = scene_rules.load_config(config_path)
    cfg["blend"] = _resolve(cfg["blend"], PROJECT_ROOT)  # a relative path is relative to the project root
    with open(_resolve(cfg["overrides_file"], PROJECT_ROOT), encoding="utf-8") as fh:
        overrides = json.load(fh)
    for sub in ("models", "data", "textures"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    warnings = []
    blend_mtime = os.path.getmtime(cfg["blend"])

    scene = open_scene(cfg)
    exclude_objects(cfg, warnings)
    render_disabled, unhidden = apply_render_visibility(scene, bpy.context.view_layer)
    disabled = disable_modifiers(scene, set(cfg["disable_modifiers"]))
    lights = collect_lights(scene, warnings)
    delete_lights(scene)
    classes = classify_materials(scene, overrides)
    missing_overrides = sorted(set(overrides) - set(classes))
    if missing_overrides:
        warnings.append("overrides for materials not in use: %s" % ", ".join(missing_overrides))
    check_images(warnings)

    env, _mapping, _bg = _world_env(scene)
    sky_image = env.image if env is not None else None
    scaled = limit_textures(cfg["texture_max_px"], {sky_image} if sky_image else set())

    bake = bake_step(cfg, scene, classes, args, warnings)

    depsgraph = bpy.context.evaluated_depsgraph_get()
    bounds_min, bounds_max = scene_bounds(depsgraph)
    objects = sum(1 for o in scene.objects if o.type == "MESH" and not o.hide_render)

    city_path = os.path.join(out, "models", "city.glb")
    export_visual(city_path)
    triangles, _doc = glb_triangles(city_path)

    depsgraph = bpy.context.evaluated_depsgraph_get()
    col_obj, collision_triangles, col_used, col_skipped = build_collision(scene, depsgraph, cfg)
    collision_path = os.path.join(out, "models", "collision.glb")
    export_collision(scene, col_obj, collision_path)

    sky, sky_size = export_sky(scene, out, cfg["texture_max_px"], warnings)

    stats = {"triangles": triangles, "collision_triangles": collision_triangles, "objects": objects,
             "collision_objects": col_used,
             **{k: v for k, v in bake.items() if k != "bake_seconds"}}  # scene.json stays deterministic
    data = {
        "source": {"blend": cfg["blend"], "mtime": blend_mtime,
                   "exported": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")},
        "bounds": {"min": bounds_min, "max": bounds_max},
        "cameras": scene_rules.frame_cameras(bounds_min, bounds_max),
        "lights": lights,
        "sky": sky,
        "materials": classes,
        "overrides": overrides,
        "stats": stats,
        "warnings": warnings,
    }
    scene_path = os.path.join(out, "data", "scene.json")
    with open(scene_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)

    counts = {}
    for c in classes.values():
        counts[c] = counts.get(c, 0) + 1
    report = {k: v for k, v in stats.items() if k != "collision_objects"}
    report.update({
        "lights": len(lights),
        "materials": counts,
        "modifiers_disabled": disabled,
        "render_disabled": render_disabled,
        "viewport_unhidden": unhidden,
        "textures_scaled": scaled,
        "collision_objects": len(col_used),
        "collision_skipped": col_skipped,
        "sky": sky["file"], "sky_size": sky_size,
        "warnings": len(warnings),
        "bytes": {rel: os.path.getsize(os.path.join(out, rel))
                  for rel in ("models/city.glb", "models/collision.glb", "data/scene.json")},
        "bake_seconds": bake["bake_seconds"],
        "seconds": round(time.perf_counter() - started, 1),
    })
    return report


def main(argv):
    parser = argparse.ArgumentParser(prog="export_scene.py")
    parser.add_argument("--config", default=os.path.join(PROJECT_ROOT, "config", "export_config.json"))
    parser.add_argument("--out", default=os.path.join(PROJECT_ROOT, "web", "public"))
    parser.add_argument("--no-bake", action="store_true", help="skip baking procedural materials")
    parser.add_argument("--bake-cache", default=os.path.join(SCRIPT_DIR, "cache", "bake"),
                        help="folder of baked PNGs reused across runs (default blender/cache/bake)")
    args = parser.parse_args(argv)
    try:
        report = run(args)
    except BaseException:
        import traceback
        traceback.print_exc()
        sys.stderr.write("CS_EXPORT_FAILED\n")
        sys.stderr.flush()
        sys.stdout.flush()
        os._exit(1)
    sys.stdout.write("CS_EXPORT_OK " + json.dumps(report, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
