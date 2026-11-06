"""Bake procedural materials to plain textures (bpy; called from export_scene.py).

For every (object, material) pair whose material is in the "bake" class, the material's final
diffuse colour (Cycles CPU, DIFFUSE pass, colour only - no direct/indirect light) is baked into a
PNG under cache_dir, and the in-memory material is replaced by a plain Principled BSDF reading it.

Two routes:
* tile - the material's colour depends on UV coordinates only (no Object / Generated / Position /
  Geometry / AO / attribute input anywhere upstream of the Surface, groups included) and reads a
  single UV map of the object. It is baked once, as one size_px tile, on a temporary unit quad
  whose UVs span exactly 0..1, and the replacement samples the tile through the object's ORIGINAL
  UV map, so the glTF REPEAT wrap tiles it at full detail. (Baking on the object itself does not
  work: Cycles only bakes the part of each face that lies inside the 0..1 UV square.) The tile is
  shared by every object using the material and does not depend on the object.
* atlas - everything else. The object gets a "BakeUV" map; the faces of each baked material are
  Smart UV Projected into the whole 0..1 square (each material has its own image, so islands of
  different materials may overlap). The atlas size grows with the faces' world-space area, from
  size_px up to max_px (power of two, target TEXEL_M per texel).

Per pair, besides the colour:
* Alpha: when a top-level Principled BSDF has a linked Alpha or Alpha < 1, the alpha value is baked
  with an EMIT pass (alpha wired into an Emission shader on a temporary copy) and stored in the
  PNG's alpha channel; the replacement wires it to Alpha, through Math Round (glTF MASK) when the
  baked alpha is nearly binary, else directly (BLEND).
* Emission: when the material emits, an EMIT pass is baked to "<key>_emit.png" (normalised; the
  maximum goes into Emission Strength, so glTF gets emissiveTexture + emissive_strength).
* Metal: Metallic and Transmission are zeroed on the temporary copy (they have no diffuse colour);
  the replacement keeps the original plain Metallic / Roughness values.
* Sharing: a material used by several objects is copied per object ("<material>@<object>"); a mesh
  shared by several objects is made single-user before it gets BakeUV.

Cache: per pair a "bake_<key>.json" (written last) plus its PNGs; when the JSON exists the bake is
skipped. key = SHA-1 of BAKE_VERSION, the material digest (nodes, their settings and mute state,
unlinked inputs, links, groups, images by file mtime/size or packed data hash) and, for atlas pairs,
the object name, atlas size and an object fingerprint (mesh, original UV maps, colour attributes,
modifier settings and the world matrix - always, a simple rule that also covers world-space
shaders). Everything happens in memory; the .blend is never saved.
"""
import hashlib
import json
import math
import os

import bpy
import numpy as np

BAKE_UV = "BakeUV"
TILE_UV = "BakeTile"
PREFIX = "bake_"
BAKE_VERSION = 2   # part of the cache key: bump when the unwrap or bake settings change
TEXEL_M = 0.05     # atlas target texel size (metres)
PACKING = 0.5      # share of the atlas Smart UV Project fills
_BASE_NODE_PROPS = None
_IMAGE_SIGS = {}

PROCEDURAL = {"TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_BRICK", "TEX_MAGIC", "TEX_GRADIENT",
              "TEX_CHECKER", "TEX_MUSGRAVE", "TEX_WHITE_NOISE", "TEX_GABOR"}
# nodes whose output depends only on their inputs (or on the view direction, which a bake fixes to
# the surface normal on the object and on the tile quad alike)
UV_SAFE = {"MAPPING", "VALUE", "RGB", "MATH", "VECT_MATH", "MIX", "MIX_RGB", "VALTORGB", "CURVE_RGB",
           "CURVE_VEC", "CURVE_FLOAT", "HUE_SAT", "BRIGHTCONTRAST", "GAMMA", "INVERT", "RGBTOBW",
           "SEPARATE_COLOR", "COMBINE_COLOR", "SEPXYZ", "COMBXYZ", "SEPRGB", "COMBRGB", "SEPHSV",
           "COMBHSV", "MAP_RANGE", "CLAMP", "BLACKBODY", "WAVELENGTH", "VECTOR_ROTATE", "GROUP",
           "GROUP_INPUT", "GROUP_OUTPUT", "REROUTE", "FRAME", "EMISSION", "MIX_SHADER",
           "ADD_SHADER", "HOLDOUT", "OUTPUT_MATERIAL", "FRESNEL", "LAYER_WEIGHT", "SUBSURFACE_SCATTERING"}
SKIP_INPUTS = {"Normal", "Coat Normal", "Clearcoat Normal", "Tangent", "Displacement"}


# --- cache key ---------------------------------------------------------------------------------

def _value(v):
    if isinstance(v, float):
        return "%.5g" % v
    if isinstance(v, (bool, int, str)) or v is None:
        return repr(v)
    if hasattr(v, "name") and isinstance(getattr(v, "name"), str):
        return "<%s>" % v.name
    try:
        return "(" + ",".join("%.5g" % float(x) for x in v) + ")"
    except (TypeError, ValueError):
        return type(v).__name__


def image_signature(img):
    """Name, settings and content identity of an image: file mtime + size, or packed data hash."""
    sig = _IMAGE_SIGS.get(img.name)
    if sig is not None:
        return sig
    parts = [img.name, img.source, img.filepath, img.colorspace_settings.name, img.alpha_mode]
    if img.packed_file is not None:
        parts += ["packed", str(img.packed_file.size),
                  hashlib.sha1(bytes(img.packed_file.data)).hexdigest()]
    elif img.source in ("FILE", "SEQUENCE", "TILED", "MOVIE"):
        try:
            st = os.stat(bpy.path.abspath(img.filepath))
            parts += ["file", "%.6f" % st.st_mtime, str(st.st_size)]
        except OSError:
            parts.append("missing")
    elif img.source == "GENERATED":
        parts += [img.generated_type, _value(tuple(img.generated_color)),
                  str(img.generated_width), str(img.generated_height)]
    sig = " ".join(parts)
    _IMAGE_SIGS[img.name] = sig
    return sig


def _tree_digest(tree, out, seen):
    """Append a stable text description of a node tree (recursing into groups) to out."""
    global _BASE_NODE_PROPS
    if _BASE_NODE_PROPS is None:
        _BASE_NODE_PROPS = {p.identifier for p in bpy.types.Node.bl_rna.properties}
    if tree.name in seen:
        out.append("tree-ref %s" % tree.name)
        return
    seen.add(tree.name)
    out.append("tree %s" % tree.name)
    for node in sorted(tree.nodes, key=lambda n: n.name):
        out.append("node %s %s mute=%s" % (node.name, node.bl_idname, node.mute))
        for prop in node.bl_rna.properties:
            ident = prop.identifier
            if ident in _BASE_NODE_PROPS:
                continue
            val = getattr(node, ident, None)
            if prop.type == "POINTER":
                if val is None:
                    continue
                if isinstance(val, bpy.types.Image):
                    out.append(" image " + image_signature(val))
                elif isinstance(val, bpy.types.NodeTree):
                    _tree_digest(val, out, seen)
                elif isinstance(val, bpy.types.ColorRamp):
                    out.append(" ramp %s %s" % (val.interpolation, ";".join(
                        "%.5g:%s" % (e.position, _value(e.color)) for e in val.elements)))
                elif isinstance(val, bpy.types.CurveMapping):
                    out.append(" curves " + "|".join(";".join(
                        "%.5g,%.5g" % tuple(p.location) for p in c.points) for c in val.curves))
                elif isinstance(val, bpy.types.ImageUser):
                    out.append(" image_user %s %s" % (val.frame_offset, val.tile))
                elif hasattr(val, "name"):
                    out.append(" %s=%s" % (ident, val.name))
            elif prop.type != "COLLECTION" and not prop.is_readonly:
                out.append(" %s=%s" % (ident, _value(val)))
        for sock in node.inputs:
            if not sock.is_linked and hasattr(sock, "default_value"):
                out.append(" in %s=%s" % (sock.identifier, _value(sock.default_value)))
    out.extend(sorted("link %s.%s>%s.%s" % (link.from_node.name, link.from_socket.identifier,
                                            link.to_node.name, link.to_socket.identifier)
                      for link in tree.links if not link.is_muted))


def material_digest(mat):
    lines = ["material %s" % mat.name]
    if mat.node_tree is not None:
        _tree_digest(mat.node_tree, lines, set())
    return hashlib.sha1("\n".join(lines).encode("utf-8")).hexdigest()


def _rna_values(struct):
    out = []
    for prop in struct.bl_rna.properties:
        if prop.identifier == "rna_type" or prop.type == "COLLECTION" or prop.is_readonly:
            continue  # read-only ones include runtime data such as execution_time
        out.append("%s=%s" % (prop.identifier, _value(getattr(struct, prop.identifier, None))))
    return out


def object_fingerprint(obj):
    """What an atlas bake depends on besides the material: mesh, original UV maps, colour
    attributes, modifier settings (Geometry Nodes inputs included) and the world matrix."""
    me = obj.data
    h = hashlib.sha1()

    def arr(coll, attr, dtype, width):
        a = np.empty(len(coll) * width, dtype=dtype)
        coll.foreach_get(attr, a)
        h.update(a.tobytes())

    arr(me.vertices, "co", np.float32, 3)
    arr(me.polygons, "loop_total", np.int32, 1)
    arr(me.polygons, "material_index", np.int32, 1)
    arr(me.loops, "vertex_index", np.int32, 1)
    for layer in me.uv_layers:
        if layer.name in (BAKE_UV, TILE_UV):
            continue
        h.update(("uv %s %s" % (layer.name, layer.active_render)).encode("utf-8"))
        arr(layer.data, "uv", np.float32, 2)
    for attr in me.color_attributes:
        h.update(("color %s %s %s" % (attr.name, attr.domain, attr.data_type)).encode("utf-8"))
        arr(attr.data, "color", np.float32, 4)
    h.update(np.array(obj.matrix_world, dtype=np.float64).tobytes())
    for mod in obj.modifiers:
        h.update(("mod " + " ".join(_rna_values(mod))).encode("utf-8"))
        try:
            keys = mod.keys()  # Geometry Nodes inputs live in ID properties
        except TypeError:
            keys = []  # this modifier type has no ID properties
        for k in keys:
            h.update(("%s=%s" % (k, _value(mod[k]))).encode("utf-8", "replace"))
    return h.hexdigest()


def cache_key(*parts):
    text = "|".join(str(p) for p in (BAKE_VERSION,) + parts)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


# --- material analysis -------------------------------------------------------------------------

def _active_output(tree):
    outs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"]
    active = [n for n in outs if n.is_active_output] or outs
    return active[0] if active else None


def _walk_surface(tree, visit):
    """Call visit(node, from_socket) for every node feeding the Surface (or, inside a group, the
    group outputs), skipping normal/tangent/displacement inputs; recurses into node groups."""
    if tree is None:
        return
    out = _active_output(tree)
    if out is None or out.inputs.get("Surface") is None:
        return
    _walk(tree, [out.inputs["Surface"]], visit)


def _walk(tree, sockets, visit):
    stack = list(sockets)
    seen_links, expanded = set(), set()
    while stack:
        sock = stack.pop()
        for link in sock.links:
            if link.is_muted:
                continue
            node = link.from_node
            tag = (node.name, link.from_socket.identifier)
            if tag in seen_links:
                continue
            seen_links.add(tag)
            visit(node, link.from_socket)
            if node.name in expanded:
                continue
            expanded.add(node.name)
            if node.type == "GROUP" and node.node_tree is not None:
                inner = [s for n in node.node_tree.nodes if n.type == "GROUP_OUTPUT"
                         for s in n.inputs if s.name not in SKIP_INPUTS]
                _walk(node.node_tree, inner, visit)
            stack.extend(s for s in node.inputs if s.name not in SKIP_INPUTS)


def analyze_material(mat):
    """{"uv_only": bool, "uv_names": set ('' = the object's render UV map), "alpha": bool,
    "emission": bool} from the nodes feeding the Surface."""
    res = {"uv_only": True, "uv_names": set(), "alpha": False, "emission": False}

    def linked_or(sock, test):
        return sock is not None and (sock.is_linked or test(sock.default_value))

    def visit(node, from_socket):
        t = node.type
        if t == "TEX_COORD":
            if from_socket.name == "UV":
                res["uv_names"].add("")
            else:
                res["uv_only"] = False
        elif t == "UVMAP":
            res["uv_names"].add(node.uv_map)
        elif t == "TEX_IMAGE":
            if node.projection != "FLAT":
                res["uv_only"] = False
            if not node.inputs["Vector"].is_linked:
                res["uv_names"].add("")
        elif t in PROCEDURAL:
            vec = node.inputs.get("Vector")
            if vec is None or not vec.is_linked:
                res["uv_only"] = False  # unlinked vector = Generated coordinates
        elif t not in UV_SAFE and not t.startswith("BSDF_"):
            res["uv_only"] = False
        if t == "BSDF_PRINCIPLED":
            emits = (linked_or(node.inputs.get("Emission Strength"), lambda v: v > 0.0)
                     and linked_or(node.inputs.get("Emission Color"), lambda v: max(v[:3]) > 0.0))
            res["emission"] = res["emission"] or emits
        elif t == "EMISSION":
            emits = (linked_or(node.inputs.get("Strength"), lambda v: v > 0.0)
                     and linked_or(node.inputs.get("Color"), lambda v: max(v[:3]) > 0.0))
            res["emission"] = res["emission"] or emits

    _walk_surface(mat.node_tree, visit)
    res["alpha"] = _alpha_principled(mat.node_tree) is not None
    return res


def _alpha_principled(tree):
    """The top-level Principled BSDF whose Alpha is linked or below 1, if any."""
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            a = node.inputs.get("Alpha")
            if a is not None and (a.is_linked or a.default_value < 0.999):
                return node
    return None


def _principled_values(mat):
    """Metallic / roughness of a top-level Principled BSDF when they are plain values."""
    metallic, roughness = 0.0, 0.5
    tree = mat.node_tree
    if tree is not None:
        for node in tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                if not node.inputs["Metallic"].is_linked:
                    metallic = float(node.inputs["Metallic"].default_value)
                if not node.inputs["Roughness"].is_linked:
                    roughness = float(node.inputs["Roughness"].default_value)
                break
    return metallic, roughness


def _neutralize_metal(tree, copies):
    """Metallic and transmissive closures have no diffuse colour; zero them so the DIFFUSE colour
    bake keeps the base colour. Node groups are copied first, so other materials are unaffected."""
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            for name in ("Metallic", "Transmission Weight"):
                sock = node.inputs.get(name)
                if sock is None:
                    continue
                for link in list(sock.links):
                    tree.links.remove(link)
                sock.default_value = 0.0
        elif node.type == "GROUP" and node.node_tree is not None:
            group = node.node_tree
            if group.name not in copies:
                copies[group.name] = group.copy()
                _neutralize_metal(copies[group.name], copies)
            node.node_tree = copies[group.name]


def _wire_alpha_to_emission(tree):
    """Make the surface emit the Principled Alpha value (grey) so an EMIT bake captures it."""
    bsdf = _alpha_principled(tree)
    out = _active_output(tree)
    if bsdf is None or out is None:
        return False
    em = tree.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    alpha = bsdf.inputs["Alpha"]
    if alpha.is_linked:
        tree.links.new(alpha.links[0].from_socket, em.inputs["Color"])
    else:
        v = float(alpha.default_value)
        em.inputs["Color"].default_value = (v, v, v, 1.0)
    for link in list(out.inputs["Surface"].links):
        tree.links.remove(link)
    tree.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return True


def replace_with_texture(mat, color_image, uv_name, metallic, roughness, alpha_mode=None,
                         emit_image=None, emit_strength=0.0):
    tree = mat.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = uv_name
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = color_image
    tree.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha_mode:
        color_image.alpha_mode = "STRAIGHT"
        if alpha_mode == "MASK":
            clip = tree.nodes.new("ShaderNodeMath")
            clip.operation = "ROUND"  # the glTF exporter reads Round as MASK, cutoff 0.5
            tree.links.new(tex.outputs["Alpha"], clip.inputs[0])
            tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
        else:
            tree.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED" if alpha_mode == "MASK" else "BLENDED"
    if emit_image is not None:
        etex = tree.nodes.new("ShaderNodeTexImage")
        etex.image = emit_image
        tree.links.new(uv.outputs["UV"], etex.inputs["Vector"])
        tree.links.new(etex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emit_strength


# --- geometry helpers --------------------------------------------------------------------------

def _faces_by_slot(obj):
    mi = np.empty(len(obj.data.polygons), dtype=np.int32)
    obj.data.polygons.foreach_get("material_index", mi)
    return np.bincount(mi, minlength=len(obj.material_slots)) if len(mi) else np.zeros(len(obj.material_slots), int)


def world_area(obj, slots):
    """World-space area (m^2) of the object's faces in the given material slots."""
    me = obj.data
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    if n == 0:
        return 0.0
    vi = np.empty(n * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("vertices", vi)
    pi = np.empty(n, dtype=np.int32)
    me.loop_triangles.foreach_get("polygon_index", pi)
    mi = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("material_index", mi)
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    m = np.array(obj.matrix_world, dtype=np.float64)
    co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    tri = co[vi].reshape(-1, 3, 3)
    areas = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    return float(areas[np.isin(mi[pi], slots)].sum())


def atlas_size(area, size_px, max_px):
    needed = math.sqrt(max(area, 0.0) / PACKING) / TEXEL_M
    size = size_px
    while size < needed and size * 2 <= max_px:
        size *= 2
    return size


def _select_only(obj):
    view_layer = bpy.context.view_layer
    for other in view_layer.objects:
        if other.select_get():
            other.select_set(False)
    obj.select_set(True)
    view_layer.objects.active = obj


def _unwrap(obj, slot_sets):
    """Smart UV Project the faces of each slot set into the whole 0..1 square of BakeUV. The
    active and active-render UV maps are restored, so other materials keep their UVs."""
    me = obj.data
    render = next((l.name for l in me.uv_layers if l.active_render), None)
    active = me.uv_layers.active.name if me.uv_layers.active is not None else None
    uv = me.uv_layers.get(BAKE_UV)
    if uv is None:
        uv = me.uv_layers.new(name=BAKE_UV, do_init=False)
        if uv is None:
            raise RuntimeError("cannot add a UV map to %s" % obj.name)
    me.uv_layers.active = uv
    _select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.context.tool_settings.mesh_select_mode = (False, False, True)
        for slots in slot_sets:
            bpy.ops.mesh.select_all(action="DESELECT")
            for index in slots:
                obj.active_material_index = index
                bpy.ops.object.material_slot_select()
            bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.01,
                                     area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        if render is not None:
            me.uv_layers[render].active_render = True
        if active is not None:
            me.uv_layers.active = me.uv_layers[active]


def _tile_object(scene, count, uv_names):
    """A temporary mesh of `count` separate unit quads, quad i in material slot i, each with UVs
    spanning exactly 0..1 in every UV map the tile materials read."""
    me = bpy.data.meshes.new("cs_bake_tiles")
    verts, faces = [], []
    for i in range(count):
        x = 1.5 * i
        verts += [(x, 0, 0), (x + 1, 0, 0), (x + 1, 1, 0), (x, 1, 0)]
        faces.append((4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3))
    me.from_pydata(verts, [], faces)
    unit = np.tile(np.array([0, 0, 1, 0, 1, 1, 0, 1], dtype=np.float32), count)
    for name in [TILE_UV] + sorted(n for n in uv_names if n and n != TILE_UV)[:7]:
        layer = me.uv_layers.new(name=name)
        layer.data.foreach_set("uv", unit)
    me.polygons.foreach_set("material_index", np.arange(count, dtype=np.int32))
    me.update()
    obj = bpy.data.objects.new("cs_bake_tiles", me)
    scene.collection.objects.link(obj)
    return obj


# --- baking ------------------------------------------------------------------------------------

def _setup_cycles(scene):
    saved = {"engine": scene.render.engine}
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    bake = scene.render.bake
    bake.use_pass_direct = False
    bake.use_pass_indirect = False
    bake.use_pass_color = True
    bake.margin = 8
    bake.use_clear = True
    bake.target = "IMAGE_TEXTURES"
    bake.use_selected_to_active = False
    return saved


def _pixels(image):
    a = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def _save_png(pixels, size, path, alpha):
    image = bpy.data.images.new("cs_bake_out", size, size, alpha=alpha)
    try:
        image.pixels.foreach_set(np.ascontiguousarray(pixels, dtype=np.float32).ravel())
        tmp = path + ".tmp.png"
        image.filepath_raw = tmp
        image.file_format = "PNG"
        image.save()
        os.replace(tmp, path)
    finally:
        bpy.data.images.remove(image)


def _linear_to_srgb(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def _paths(cache_dir, key):
    base = os.path.join(cache_dir, PREFIX + key)
    return {"meta": base + ".json", "color": base + ".png", "emit": base + "_emit.png"}


def _bake_passes(obj, jobs, uv_layer, dummy, cache_dir):
    """Bake the jobs ({source, slots, size, key, info}) on obj: DIFFUSE colour, then EMIT for
    emission, then EMIT of the alpha value; write each job's PNGs and finally its JSON."""
    group_copies, temp_mats, temp_nodes, images = {}, [], [], []
    original = {i: obj.material_slots[i].material for job in jobs for i in job["slots"]}
    try:
        for job in jobs:
            work = job["source"].copy()
            temp_mats.append(work)
            job["work"] = work
            for i in job["slots"]:
                obj.material_slots[i].material = work
            _neutralize_metal(work.node_tree, group_copies)
            node = work.node_tree.nodes.new("ShaderNodeTexImage")
            work.node_tree.nodes.active = node
            job["node"] = node
        baking = {job["work"].name for job in jobs}
        seen = set()
        for slot in obj.material_slots:  # other materials: a throwaway active image
            mat = slot.material
            if mat is None or mat.node_tree is None or mat.name in baking or mat.name in seen:
                continue
            seen.add(mat.name)
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = dummy
            temp_nodes.append((mat.node_tree, node, mat.node_tree.nodes.active))
            mat.node_tree.nodes.active = node

        def run(kind, bake_type, wanted, float_buffer):
            for job in jobs:
                if wanted(job):
                    img = bpy.data.images.new("cs_bake_%s_%s" % (kind, job["key"][:10]), job["size"],
                                              job["size"], alpha=False, float_buffer=float_buffer)
                    images.append(img)
                    job[kind] = img
                    job["node"].image = img
                else:
                    job["node"].image = dummy
            _select_only(obj)
            kwargs = {"pass_filter": {"COLOR"}} if bake_type == "DIFFUSE" else {}
            bpy.ops.object.bake(type=bake_type, uv_layer=uv_layer, margin=8, use_clear=True,
                                target="IMAGE_TEXTURES", save_mode="INTERNAL", **kwargs)

        run("color", "DIFFUSE", lambda j: True, False)
        if any(j["info"]["emission"] for j in jobs):
            run("emit", "EMIT", lambda j: j["info"]["emission"], True)
        alpha_jobs = [j for j in jobs if j["info"]["alpha"] and _wire_alpha_to_emission(j["work"].node_tree)]
        if alpha_jobs:
            ids = {id(j) for j in alpha_jobs}
            run("alpha", "EMIT", lambda j: id(j) in ids, True)

        for job in jobs:
            paths = _paths(cache_dir, job["key"])
            meta = {"alpha": None, "emit_strength": 0.0, "size": job["size"]}
            color = _pixels(job["color"]).copy()
            color[:, 3] = 1.0
            if "alpha" in job:
                a = np.clip(_pixels(job["alpha"])[:, 0], 0.0, 1.0)
                if float(a.min()) < 0.98:
                    color[:, 3] = a
                    partial = float(np.mean((a > 0.1) & (a < 0.9)))
                    meta["alpha"] = "MASK" if partial < 0.1 else "BLEND"
            _save_png(color, job["size"], paths["color"], alpha=meta["alpha"] is not None)
            if "emit" in job:
                e = _pixels(job["emit"])[:, :3]
                peak = float(e.max())
                if peak > 1e-4:
                    strength = max(peak, 1.0)
                    rgba = np.concatenate([_linear_to_srgb(e / strength),
                                           np.ones((len(e), 1), dtype=np.float32)], axis=1)
                    _save_png(rgba, job["size"], paths["emit"], alpha=False)
                    meta["emit_strength"] = round(strength, 5)
            tmp = paths["meta"] + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(meta, fh)
            os.replace(tmp, paths["meta"])
    finally:
        for tree, node, active in reversed(temp_nodes):
            tree.nodes.remove(node)
            if active is not None:
                tree.nodes.active = active
        for i, mat in original.items():
            obj.material_slots[i].material = mat
        for work in temp_mats:
            bpy.data.materials.remove(work)
        for group in group_copies.values():
            bpy.data.node_groups.remove(group)
        for image in images:
            bpy.data.images.remove(image)


def _load_image(path):
    image = bpy.data.images.load(path, check_existing=True)
    image.name = os.path.splitext(os.path.basename(path))[0]
    return image


# --- main --------------------------------------------------------------------------------------

def bake_materials(objects, materials, size_px, cache_dir, stats=None, warnings=None, log=None,
                   max_px=None):
    """Bake each (object, material in `materials`) pair; returns {"<object>/<material>": png path}.

    `stats`, if given, receives {"baked", "cached", "unused" (materials on no face of a visible mesh
    object), "tiled", "atlas", "alpha", "emissive" (material name lists)}; problems go to
    `warnings`. Atlas textures grow with the faces' area from size_px up to max_px."""
    log = log or (lambda msg: None)
    warnings = warnings if warnings is not None else []
    stats = stats if stats is not None else {}
    max_px = max(size_px, max_px or size_px)
    stats.update({"baked": 0, "cached": 0, "unused": [], "tiled": [], "atlas": [], "alpha": [],
                  "emissive": []})
    os.makedirs(cache_dir, exist_ok=True)
    _IMAGE_SIGS.clear()
    scene = bpy.context.scene
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    # (object, {material name: [slot indices with faces]}) for every visible mesh object
    plan, users = [], {}
    for obj in objects:
        if obj.type != "MESH" or obj.hide_render or not obj.visible_get():
            continue
        faces = _faces_by_slot(obj)
        mats = {}
        for i, slot in enumerate(obj.material_slots):
            if slot.material is not None and slot.material.name in materials and faces[i] > 0:
                mats.setdefault(slot.material.name, []).append(i)
        if mats:
            plan.append((obj, mats))
            for name in mats:
                users[name] = users.get(name, 0) + 1
    stats["unused"] = sorted(set(materials) - set(users))

    sources = {name: bpy.data.materials[name] for name in users}
    digests = {name: material_digest(m) for name, m in sources.items()}
    infos = {name: analyze_material(m) for name, m in sources.items()}
    values = {name: _principled_values(m) for name, m in sources.items()}

    # decide the route, size and cache key of every pair before anything changes
    pairs = []
    for obj, mats in plan:
        me = obj.data
        render = next((l.name for l in me.uv_layers if l.active_render), None)
        fingerprint = None
        for name, slots in sorted(mats.items()):
            info = infos[name]
            uv_name = None
            if info["uv_only"] and render is not None:
                resolved = {render if n == "" else n for n in info["uv_names"]} or {render}
                if len(resolved) == 1 and next(iter(resolved)) in me.uv_layers:
                    uv_name = next(iter(resolved))
            if uv_name is not None:
                route, size, area = "tile", size_px, None
                key = cache_key("tile", digests[name], size)
            else:
                route, area = "atlas", world_area(obj, slots)
                size = atlas_size(area, size_px, max_px)
                fingerprint = fingerprint or object_fingerprint(obj)
                key = cache_key("atlas", digests[name], obj.name, size, fingerprint)
                uv_name = BAKE_UV
            pairs.append({"obj": obj, "name": name, "slots": slots, "route": route, "uv": uv_name,
                          "size": size, "area": area, "key": key, "source": sources[name],
                          "info": info, "cached": os.path.exists(_paths(cache_dir, key)["meta"])})

    result = {}
    failed = set()  # id(pair)
    hidden = {o: o.hide_render for o in scene.objects}
    saved = _setup_cycles(scene)
    dummy = bpy.data.images.new("cs_bake_dummy", 4, 4)
    try:
        for o in scene.objects:  # bake one object at a time, alone: a tiny Cycles scene each call
            o.hide_render = True

        # tiles: one job per distinct uncached key, all on one temporary mesh, one pass set
        tile_jobs = {}
        for p in pairs:
            if p["route"] == "tile" and not p["cached"] and p["key"] not in tile_jobs:
                tile_jobs[p["key"]] = {"source": p["source"], "key": p["key"], "size": p["size"],
                                       "info": p["info"]}
        if tile_jobs:
            jobs = list(tile_jobs.values())
            names = set().union(*(j["info"]["uv_names"] for j in jobs))
            tiles = _tile_object(scene, len(jobs), names)
            try:
                for i, job in enumerate(jobs):
                    tiles.data.materials.append(job["source"])
                    job["slots"] = [i]
                _bake_passes(tiles, jobs, TILE_UV, dummy, cache_dir)
                log("baked %d tiles: %s" % (len(jobs), ", ".join(sorted(j["source"].name for j in jobs))))
            except Exception as exc:
                warnings.append("bake failed for tile materials: %s" % exc)
                failed.update(id(p) for p in pairs if p["route"] == "tile" and not p["cached"])
            finally:
                mesh = tiles.data
                bpy.data.objects.remove(tiles, do_unlink=True)
                bpy.data.meshes.remove(mesh)

        # atlases: per object, BakeUV + one pass set for its uncached atlas pairs
        for obj, _mats in plan:
            mine = [p for p in pairs if p["obj"] is obj and p["route"] == "atlas"]
            if not mine:
                continue
            try:
                if obj.data.users > 1:
                    obj.data = obj.data.copy()  # its BakeUV and per-object materials stay its own
                _unwrap(obj, [p["slots"] for p in mine])
                todo = [p for p in mine if not p["cached"]]
                if todo:
                    jobs = [{"source": p["source"], "slots": p["slots"], "key": p["key"],
                             "size": p["size"], "info": p["info"]} for p in todo]
                    obj.hide_render = False
                    try:
                        _bake_passes(obj, jobs, BAKE_UV, dummy, cache_dir)
                    finally:
                        obj.hide_render = True
                    log("baked %s: %s" % (obj.name, ", ".join(
                        "%s (%dpx, %.0f m2)" % (p["name"], p["size"], p["area"]) for p in todo)))
            except Exception as exc:  # leave this object's materials procedural, keep exporting
                warnings.append("bake failed for %s: %s" % (obj.name, exc))
                failed.update(id(p) for p in mine)
    finally:
        for o, flag in hidden.items():
            o.hide_render = flag
        scene.render.engine = saved["engine"]
        bpy.data.images.remove(dummy)

    # replace the materials with the baked textures
    for p in pairs:
        if id(p) in failed:
            continue
        paths = _paths(cache_dir, p["key"])
        with open(paths["meta"], encoding="utf-8") as fh:
            meta = json.load(fh)
        obj, name = p["obj"], p["name"]
        if users[name] > 1:
            target = p["source"].copy()
            target.name = "%s@%s" % (name, obj.name)
            for i in p["slots"]:
                obj.material_slots[i].material = target
        else:
            target = p["source"]
        emit = _load_image(paths["emit"]) if meta["emit_strength"] > 0 else None
        replace_with_texture(target, _load_image(paths["color"]), p["uv"], *values[name],
                             alpha_mode=meta["alpha"], emit_image=emit,
                             emit_strength=meta["emit_strength"])
        result["%s/%s" % (obj.name, name)] = paths["color"]
        stats["cached" if p["cached"] else "baked"] += 1
        stats[p["route"] == "tile" and "tiled" or "atlas"].append(name)
        if meta["alpha"]:
            stats["alpha"].append(name)
        if emit is not None:
            stats["emissive"].append(name)
    for k in ("tiled", "atlas", "alpha", "emissive"):
        stats[k] = sorted(set(stats[k]))
    stats["pairs"] = [{"pair": "%s/%s" % (p["obj"].name, p["name"]), "route": p["route"],
                       "size": p["size"], "area": None if p["area"] is None else round(p["area"], 1)}
                      for p in pairs if id(p) not in failed]
    return result
