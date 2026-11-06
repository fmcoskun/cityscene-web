"""Blender reference stills from the same cameras as the web app's e2e shots.

Run in a background Blender (never the interactive one); the .blend is opened and never saved:

    blender --background --factory-startup CityScene.blend \
        --python blender/render_reference.py -- --views web/e2e/views.json --out <output folder>

views.json (written by web/e2e/run.mjs) is a list of
    {"name": str, "position": [x, y, z], "quaternion": [x, y, z, w], "fov": deg, "width": px, "height": px}
in three.js axes: the web camera's world position, orientation and vertical field of view.
Each view is rendered with EEVEE, the scene's own world, lights and view transform (Filmic), to
<out>/<name>.png. --samples sets EEVEE's render samples (default 32), --only renders a subset.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

# three.js (x, y, z) is Blender (x, -z, y): the inverse of the GLB exporter's y-up mapping.
THREE_TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def blender_camera_pose(position, quaternion):
    """Blender location and rotation for a three.js camera pose.

    Both cameras look down their local -Z with +Y up, so the camera's local frame carries over
    unchanged and only the world axes are swapped: R_blender = C * R_three, p_blender = C * p_three.
    """
    x, y, z, w = quaternion
    rotation = THREE_TO_BLENDER @ Quaternion((w, x, y, z)).to_matrix()
    return THREE_TO_BLENDER @ Vector(position), rotation.to_euler("XYZ")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--views", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--only", nargs="*", default=None)
    return parser.parse_args(argv)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parse_args(argv)
    with open(args.views, encoding="utf-8") as handle:
        views = json.load(handle)
    if args.only:
        views = [view for view in views if view["name"] in args.only]
    os.makedirs(args.out, exist_ok=True)

    scene = bpy.context.scene
    # Blender 5.x names EEVEE "BLENDER_EEVEE"; 4.2-4.4 called it "BLENDER_EEVEE_NEXT".
    engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = args.samples
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    camera_data = bpy.data.cameras.new("ReferenceCamera")
    camera_data.sensor_fit = "VERTICAL"
    camera_data.clip_start = 0.1
    camera_data.clip_end = 2000
    camera = bpy.data.objects.new("ReferenceCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    print(f"render_reference: Blender {bpy.app.version_string}, engine {scene.render.engine}, "
          f"view transform {scene.view_settings.view_transform}, exposure {scene.view_settings.exposure}")
    for view in views:
        location, rotation = blender_camera_pose(view["position"], view["quaternion"])
        camera.location = location
        camera.rotation_euler = rotation
        camera_data.angle = math.radians(view["fov"])
        scene.render.resolution_x = int(view["width"])
        scene.render.resolution_y = int(view["height"])
        scene.render.filepath = os.path.join(os.path.abspath(args.out), f"{view['name']}.png")
        bpy.ops.render.render(write_still=True)
        print(f"render_reference: {view['name']} -> {scene.render.filepath} "
              f"at {tuple(round(v, 2) for v in location)}, rotation {tuple(round(math.degrees(a), 1) for a in rotation)}")
    # Nothing is saved: the .blend on disk stays as it was.


if __name__ == "__main__":
    main()
