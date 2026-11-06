"""Print a JSON summary of material node trees, used to fill config/material_overrides.json.

    blender --background --factory-startup --python blender/inspect_materials.py -- \
        --blend CityScene.blend [--names "NEON STRIP" "GLASS" ...] [--out file.json]

For each material: every node with its type, unlinked input values (colours, strengths, factors),
ColorRamp stops, and the links between nodes. Without --names, every material in the file is listed.
Never saves the .blend.
"""
import argparse
import json
import sys

import bpy


def _value(v):
    try:
        return [round(float(x), 4) for x in v]
    except TypeError:
        pass
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, (int, bool, str)):
        return v
    return None


def _node(node, depth=0):
    out = {"type": node.type, "label": node.label or None}
    inputs = {}
    for sock in node.inputs:
        if not sock.enabled:
            continue
        key = sock.name if sock.name not in inputs else sock.identifier
        if sock.is_linked:
            inputs[key] = "<linked>"
        elif hasattr(sock, "default_value"):
            val = _value(sock.default_value)
            if val is not None:
                inputs[key] = val
    out["inputs"] = inputs
    if node.type == "VALTORGB":
        ramp = node.color_ramp
        out["ramp"] = {"interpolation": ramp.interpolation,
                       "stops": [{"pos": round(e.position, 4), "color": _value(e.color)} for e in ramp.elements]}
    if node.type in ("RGB",):
        out["color"] = _value(node.outputs[0].default_value)
    if node.type == "VALUE":
        out["value"] = _value(node.outputs[0].default_value)
    if node.type == "TEX_IMAGE" and node.image:
        out["image"] = node.image.name
    if node.type == "GROUP" and node.node_tree:
        out["group"] = node.node_tree.name
        if depth < 2:
            out["group_nodes"] = {n.name: _node(n, depth + 1) for n in node.node_tree.nodes
                                  if n.type not in ("FRAME", "REROUTE", "GROUP_INPUT", "GROUP_OUTPUT")}
    for attr in ("blend_type", "data_type", "operation"):
        if hasattr(node, attr):
            out[attr] = getattr(node, attr)
    return out


def summarize(mat):
    if mat.node_tree is None:
        return {"node_tree": False, "diffuse_color": _value(mat.diffuse_color)}
    tree = mat.node_tree
    return {
        "diffuse_color": _value(mat.diffuse_color),
        "blend_method": getattr(mat, "blend_method", None),
        "nodes": {n.name: _node(n) for n in tree.nodes},
        "links": ["%s.%s -> %s.%s" % (l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier)
                  for l in tree.links],
    }


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--blend", required=True)
    parser.add_argument("--names", nargs="*", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False)
    names = args.names or sorted(m.name for m in bpy.data.materials)
    result = {}
    for name in names:
        mat = bpy.data.materials.get(name)
        result[name] = summarize(mat) if mat else {"missing": True}
    text = json.dumps(result, indent=1, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("CS_INSPECT_OK %d materials -> %s" % (len(result), args.out))
    else:
        print(text)
        print("CS_INSPECT_OK %d materials" % len(result))


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
