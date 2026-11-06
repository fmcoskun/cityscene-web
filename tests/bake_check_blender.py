"""Blender-side checks of blender/bake.py on a tiny in-memory scene (run by tests/test_bake.py).

    blender --background --factory-startup --python tests/bake_check_blender.py -- --work DIR

Prints one line "CS_CHECK <json>": {check name: [passed, detail]}. Never opens or saves a .blend.
"""
import json
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "blender"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bake  # noqa: E402

RESULTS = {}


def check(name, ok, detail=""):
    RESULTS[name] = [bool(ok), str(detail)]


def quads(name, size, uv_scale, materials):
    """One size x size m quad per material (side by side), slot i on quad i, UVMap 0..uv_scale."""
    verts, faces = [], []
    for i in range(len(materials)):
        x = i * (size + 1)
        verts += [(x, 0, 0), (x + size, 0, 0), (x + size, size, 0), (x, size, 0)]
        faces.append((4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    uv.data.foreach_set("uv", np.tile(np.array([0, 0, 1, 0, 1, 1, 0, 1], np.float32) * uv_scale, len(materials)))
    for mat in materials:
        me.materials.append(mat)
    me.polygons.foreach_set("material_index", np.arange(len(materials), dtype=np.int32))
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # UV-only brick with a cut-out alpha: tile route, MASK
    a = bpy.data.materials.new("TileAlpha")
    a.use_nodes = True
    nt = a.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.name = "Mapping"
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.inputs["Scale"].default_value = 2.0
    nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(brick.outputs["Fac"], inv.inputs[1])
    nt.links.new(inv.outputs["Value"], bsdf.inputs["Alpha"])
    # Generated-coordinate noise that glows: atlas route, emissive
    g = bpy.data.materials.new("GlowGen")
    g.use_nodes = True
    nt = g.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    noise = nt.nodes.new("ShaderNodeTexNoise")
    nt.links.new(noise.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(noise.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 5.0
    # plain image material (not baked) on the same object as GlowGen
    p = bpy.data.materials.new("Plain")
    p.use_nodes = True
    img = bpy.data.images.new("plain_img", 8, 8)
    img.generated_type = "COLOR_GRID"
    tex = p.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    p.node_tree.links.new(tex.outputs["Color"], p.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    tile_obj = quads("TileObj", 4.0, 4.0, [a])
    glow_obj = quads("GlowObj", 4.0, 1.0, [g, p])
    return tile_obj, glow_obj


def check_digests(work):
    tile_obj, glow_obj = build()
    mat = bpy.data.materials["TileAlpha"]
    d0 = bake.material_digest(mat)
    mat.node_tree.nodes["Mapping"].mute = True
    d1 = bake.material_digest(mat)
    mat.node_tree.nodes["Mapping"].mute = False
    check("digest_changes_on_mute", d0 != d1 and bake.material_digest(mat) == d0, (d0[:8], d1[:8]))

    path = os.path.join(work, "img.png")
    img = bpy.data.images.new("file_img", 4, 4)
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img.source = "FILE"
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    bake._IMAGE_SIGS.clear()
    s0 = bake.material_digest(mat)
    st = os.stat(path)
    os.utime(path, (st.st_atime, st.st_mtime + 100))
    bake._IMAGE_SIGS.clear()
    check("digest_changes_on_image_file", bake.material_digest(mat) != s0)

    f0 = bake.object_fingerprint(glow_obj)
    mod = glow_obj.modifiers.new("Solid", "SOLIDIFY")
    mod.thickness = 0.1
    f1 = bake.object_fingerprint(glow_obj)
    mod.thickness = 0.2
    f2 = bake.object_fingerprint(glow_obj)
    glow_obj.location.x += 1.0
    bpy.context.view_layer.update()
    f3 = bake.object_fingerprint(glow_obj)
    glow_obj.data.uv_layers["UVMap"].data[0].uv = (0.5, 0.5)
    f4 = bake.object_fingerprint(glow_obj)
    check("fingerprint_changes", len({f0, f1, f2, f3, f4}) == 5)


def run_bake(cache):
    tile_obj, glow_obj = build()
    stats, warnings = {}, []
    done = bake.bake_materials([tile_obj, glow_obj], {"TileAlpha", "GlowGen"}, 64, cache,
                               stats=stats, warnings=warnings, max_px=128)
    return tile_obj, glow_obj, stats, warnings, done


def glb_json(path):
    import struct
    with open(path, "rb") as fh:
        fh.read(12)
        n, _ = struct.unpack("<I4s", fh.read(8))
        return json.loads(fh.read(n))


def check_bake(work):
    cache = os.path.join(work, "cache")
    tile_obj, glow_obj, stats, warnings, done = run_bake(cache)
    check("bake_no_warnings", not warnings, warnings)
    check("routes", stats["tiled"] == ["TileAlpha"] and stats["atlas"] == ["GlowGen"], stats)
    check("alpha_and_emission_found", stats["alpha"] == ["TileAlpha"] and stats["emissive"] == ["GlowGen"], stats)
    sizes = {p["pair"]: p["size"] for p in stats["pairs"]}
    check("atlas_grows_with_area", sizes.get("GlowObj/GlowGen") == 128 and sizes.get("TileObj/TileAlpha") == 64, sizes)
    uvs = glow_obj.data.uv_layers
    check("active_uv_restored", uvs.active.name == "UVMap" and uvs["UVMap"].active_render,
          (uvs.active.name, [l.name for l in uvs if l.active_render]))
    check("tile_keeps_original_uv", "BakeUV" not in tile_obj.data.uv_layers)

    png = done.get("TileObj/TileAlpha")
    img = bpy.data.images.load(png, check_existing=False)
    px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(px)
    alpha = px.reshape(-1, 4)[:, 3]
    check("tile_png_has_alpha", img.channels == 4 and 0.05 < float(alpha.mean()) < 0.95,
          (img.channels, float(alpha.mean())))

    out = os.path.join(work, "check.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_lights=False,
                              export_cameras=False, export_draco_mesh_compression_enable=False)
    doc = glb_json(out)
    mats = {m["name"]: m for m in doc["materials"]}
    tile = mats.get("TileAlpha", {})
    check("tile_alpha_mode", tile.get("alphaMode", "OPAQUE") != "OPAQUE", tile)
    glow = mats.get("GlowGen", {})
    strength = glow.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1.0)
    check("glow_emissive", "emissiveTexture" in glow and max(glow.get("emissiveFactor", [0])) > 0 and strength > 1.0, glow)
    plain_tc = mats.get("Plain", {}).get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("texCoord", 0)
    glow_tc = glow.get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("texCoord", 0)
    check("plain_texture_keeps_uvmap", plain_tc == 0 and glow_tc == 1, (plain_tc, glow_tc))
    image_names = [doc["images"][doc["textures"][m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]].get("name", "")
                   for m in (tile, glow)]
    check("bake_image_prefix", all(n.startswith("bake_") for n in image_names), image_names)

    first = (stats["baked"], stats["cached"])
    _t, _g, stats2, warnings2, _d = run_bake(cache)
    check("cache_reused", first == (2, 0) and (stats2["baked"], stats2["cached"]) == (0, 2) and not warnings2,
          (first, stats2["baked"], stats2["cached"], warnings2))


def main(argv):
    work = argv[argv.index("--work") + 1]
    os.makedirs(work, exist_ok=True)
    for fn in (check_digests, check_bake):
        try:
            fn(work)
        except Exception:
            check(fn.__name__ + "_crashed", False, traceback.format_exc()[-1500:])
    sys.stdout.write("CS_CHECK " + json.dumps(RESULTS) + "\n")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
