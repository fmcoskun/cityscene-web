"""Rebuild the web scene from CityScene.blend in one command, stopping at the first failure.

    py -3.11 build_all.py [--blender D:/BLENDER/blender.exe] [--blend X.blend] [--skip-tests] [--no-bake]

Steps: Python tests, Blender export, pnpm install, model compression, output validation, web
tests, production build. The summary (with the material routes and every export warning) is
printed and written to web/public/data/build_report.json.
"""
import argparse
import datetime
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "web", "public")
CONFIG = os.path.join(ROOT, "config", "export_config.json")
REPORT = os.path.join(PUBLIC, "data", "build_report.json")
DEFAULT_BLENDER = "D:/BLENDER/blender.exe"
EXPORT_OK = "CS_EXPORT_OK "
GLB_MAGIC = b"glTF"
MESHOPT = "EXT_meshopt_compression"
#: city.glb is committed to git, whose host refuses files of 100 MB and more.
MAX_CITY_BYTES = 100 * 1000 * 1000


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--blender", default=DEFAULT_BLENDER, help="path to blender.exe")
    parser.add_argument("--blend", default=None, help="export this .blend instead of the one in the config")
    parser.add_argument("--skip-tests", action="store_true", help="skip the Python and web tests")
    parser.add_argument("--no-bake", action="store_true", help="skip baking procedural materials")
    return parser.parse_args(argv)


def effective_config(base, blend=None):
    """A copy of the export config, with the .blend path replaced when one is given."""
    cfg = dict(base)
    if blend:
        cfg["blend"] = blend
    return cfg


def step(title, command, cwd=ROOT):
    started = time.perf_counter()
    print("== %s" % title, flush=True)
    process = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                             errors="replace", shell=isinstance(command, str))
    if process.returncode != 0:
        print(process.stdout[-3000:])
        print(process.stderr[-3000:], file=sys.stderr)
        raise SystemExit("FAILED: %s (exit %d)" % (title, process.returncode))
    print("   done in %.1f s" % (time.perf_counter() - started), flush=True)
    return process.stdout


def parse_export_report(output):
    """The stats JSON of the last CS_EXPORT_OK line in the export's stdout, or None."""
    report = None
    for line in output.splitlines():
        if line.startswith(EXPORT_OK):
            report = json.loads(line[len(EXPORT_OK):])
    return report


def export_details(report, scene):
    """(material route counts, warning lines) of an export. The routes come from the
    CS_EXPORT_OK report ({"bake": n, "gltf": n, "override": n}), else are counted from
    scene.json's materials; the warning text only scene.json carries (the report counts them)."""
    routes = report.get("materials") if isinstance(report.get("materials"), dict) else None
    if routes is None:
        routes = {}
        for route in scene.get("materials", {}).values():
            routes[route] = routes.get(route, 0) + 1
    return dict(sorted(routes.items())), list(scene.get("warnings", []))


def parse_glb_head(head):
    """(magic, JSON document or None) from the first bytes of a GLB: the 12-byte header and the
    JSON chunk. None when the bytes are not a GLB or are cut off before the end of the JSON."""
    magic = head[:4]
    if magic != GLB_MAGIC or len(head) < 20:
        return magic, None
    length, kind = struct.unpack("<I4s", head[12:20])
    if kind != b"JSON" or len(head) < 20 + length:
        return magic, None
    return magic, json.loads(head[20:20 + length].decode("utf-8"))


def read_glb_head(path):
    """parse_glb_head of the file, reading only its header and JSON chunk."""
    with open(path, "rb") as fh:
        head = fh.read(20)
        if len(head) == 20 and head[:4] == GLB_MAGIC:
            head += fh.read(struct.unpack("<I", head[12:16])[0])
    return parse_glb_head(head)


def validate_outputs(city, city_bytes, collision, report):
    """Problems with a build's outputs (empty when fine). city and collision are parse_glb_head
    results, report the CS_EXPORT_OK stats."""
    problems = []
    for name, (magic, _doc) in (("city.glb", city), ("collision.glb", collision)):
        if magic != GLB_MAGIC:
            problems.append("%s is not a GLB (starts with %r)" % (name, magic))
    doc = city[1]
    if doc is None:
        problems.append("city.glb has no readable JSON chunk")
    elif MESHOPT not in doc.get("extensionsUsed", []):
        problems.append("city.glb is not compressed (%s missing)" % MESHOPT)
    if city_bytes >= MAX_CITY_BYTES:
        problems.append("city.glb is %.1f MB, the limit is %d MB" % (city_bytes / 1e6, MAX_CITY_BYTES // 1000000))
    if not report.get("collision_triangles", 0) > 0:
        problems.append("collision has no triangles")
    if not report.get("lights", 0) > 0:
        problems.append("the scene exported no lights")
    return problems


def blend_path(base, blend=None):
    """The .blend the export will open."""
    if blend:
        return os.path.abspath(blend)
    return base["blend"] if os.path.isabs(base["blend"]) else os.path.join(ROOT, base["blend"])


def models_megabytes():
    folder = os.path.join(PUBLIC, "models")
    total = sum(os.path.getsize(os.path.join(folder, n)) for n in os.listdir(folder) if n.endswith(".glb"))
    return round(total / 1e6, 1)


def main(argv=None):
    args = parse_args(argv)
    started = time.perf_counter()
    pnpm = "pnpm"
    # Warnings carry file names; a console code page without their characters must not stop the build.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")

    with open(CONFIG, encoding="utf-8") as fh:
        base = json.load(fh)
    blend = blend_path(base, args.blend)
    if not os.path.isfile(blend):
        raise SystemExit("FAILED: .blend file not found: %s" % blend)

    if not args.skip_tests:
        step("Python tests", [sys.executable, "-m", "unittest", "tests.test_scene_rules", "tests.test_build_all"])

    config_path = CONFIG
    temp_path = None
    if args.blend:
        cfg = effective_config(base, os.path.abspath(args.blend))
        handle, temp_path = tempfile.mkstemp(suffix=".json", prefix="cityscene_config_")
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=1)
        config_path = temp_path
    try:
        command = [args.blender, "--background", "--factory-startup", "--python",
                   os.path.join(ROOT, "blender", "export_scene.py"), "--",
                   "--config", config_path, "--out", PUBLIC]
        if args.no_bake:
            command.append("--no-bake")
        output = step("Blender export", command)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
    export = parse_export_report(output)
    if export is None:
        print(output[-3000:])
        raise SystemExit("FAILED: Blender export (no CS_EXPORT_OK line)")
    with open(os.path.join(PUBLIC, "data", "scene.json"), encoding="utf-8") as fh:
        routes, warnings = export_details(export, json.load(fh))

    step("Install web packages", "%s --dir web install --frozen-lockfile" % pnpm)
    step("Compress models", "%s --dir web run optimize-models" % pnpm)

    print("== Validate outputs", flush=True)
    city_path = os.path.join(PUBLIC, "models", "city.glb")
    problems = validate_outputs(read_glb_head(city_path), os.path.getsize(city_path),
                                read_glb_head(os.path.join(PUBLIC, "models", "collision.glb")), export)
    for problem in problems:
        print("   PROBLEM: " + problem, file=sys.stderr)
    if problems:
        raise SystemExit("FAILED: Validate outputs (%d problem%s)" % (len(problems), "" if len(problems) == 1 else "s"))
    print("   city.glb and collision.glb are GLBs, city.glb meshopt-compressed (%.1f MB), %d collision "
          "triangles, %d lights" % (os.path.getsize(city_path) / 1e6, export["collision_triangles"], export["lights"]),
          flush=True)

    if not args.skip_tests:
        step("Web tests", "%s --dir web run test" % pnpm)
    step("Web production build", "%s --dir web run build" % pnpm)

    summary = {
        "triangles": export.get("triangles"),
        "collision_triangles": export.get("collision_triangles"),
        "lights": export.get("lights"),
        "materials": routes,
        "bake_count": export.get("bake_count"),
        "bake_cached": export.get("bake_cached"),
        "models_mb": models_megabytes(),
        "warnings": warnings,
        "seconds": round(time.perf_counter() - started, 1),
        "built_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)
    print("Material routes: " + ", ".join("%s %d" % item for item in routes.items()))
    print("Export warnings: %d" % len(warnings))
    for warning in warnings:
        print("   WARNING: " + warning)
    print("BUILD_OK " + json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
