"""Builds the tiny visibility test scene for tests/test_export_output.py (VisibilityExportTest)
and saves it as a NEW .blend at --save (a temp file; never the project's CityScene.blend).

    blender --background --factory-startup --python tests/visibility_scene_blender.py -- --save X.blend

Blender coordinates (z up), 2 m cubes standing on a 40 m ground plane:
  rendered, hidden only in the viewport (exported and collidable, ruling R19):
    ViewHidden (eye icon) at (5, 0), MonitorHidden (monitor icon) at (-5, 0),
    CollViewHidden in a collection hidden in the view layer (eye) at (0, 5),
    OrphanChild at (0, -5), child of the render-disabled RenderOff (Blender still renders it)
  render-disabled (in neither the GLB nor the collision nor the bounds):
    RenderOff (camera icon) at (100, 0), CollRenderOff in a render-disabled collection at (0, -100),
    Excluded in a collection excluded from the view layer at (-100, 0)
  lights: Lamp (point), LampOff (point, render-disabled), Sun (sun)
"""
import os
import sys

import bpy


def cube(name, x, y, collection):
    mesh = bpy.data.meshes.new(name)
    s = 1.0
    verts = [(x + dx, y + dy, z) for z in (0.0, 2.0) for dx, dy in ((-s, -s), (s, -s), (s, s), (-s, s))]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def light(name, kind, location, collection):
    data = bpy.data.lights.new(name, kind)
    data.energy = 100.0 if kind != "SUN" else 2.0
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    collection.objects.link(obj)
    return obj


def child_collection(scene, name):
    coll = bpy.data.collections.new(name)
    scene.collection.children.link(coll)
    return coll


def main(save):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    root = scene.collection
    view_layer = bpy.context.view_layer

    ground = bpy.data.meshes.new("Ground")
    ground.from_pydata([(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)])
    ground.update()
    root.objects.link(bpy.data.objects.new("Ground", ground))

    cube("ViewHidden", 5, 0, root).hide_set(True, view_layer=view_layer)
    cube("MonitorHidden", -5, 0, root).hide_viewport = True
    hidden_coll = child_collection(scene, "HiddenColl")
    cube("CollViewHidden", 0, 5, hidden_coll)
    view_layer.layer_collection.children["HiddenColl"].hide_viewport = True

    off = cube("RenderOff", 0, 0, root)
    off.location = (100, 0, 0)
    off.hide_render = True
    orphan = cube("OrphanChild", 0, 0, root)
    orphan.parent = off
    orphan.location = (-100, -5, 0)  # world (0, -5, 0): the parent sits at (100, 0, 0)
    render_coll = child_collection(scene, "RenderOffColl")
    cube("CollRenderOff", 0, -100, render_coll)
    render_coll.hide_render = True
    excluded_coll = child_collection(scene, "ExcludedColl")
    cube("Excluded", -100, 0, excluded_coll)
    view_layer.layer_collection.children["ExcludedColl"].exclude = True

    light("Lamp", "POINT", (0, 0, 5), root)
    light("LampOff", "POINT", (3, 3, 5), root).hide_render = True
    light("Sun", "SUN", (0, 0, 20), root)

    bpy.ops.wm.save_as_mainfile(filepath=save)
    print("CS_SCENE_SAVED", flush=True)


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    path = os.path.abspath(args[args.index("--save") + 1])
    if os.path.normcase(os.path.basename(path)) == os.path.normcase("CityScene.blend"):
        raise SystemExit("refusing to write CityScene.blend")
    main(path)
