import json
import os
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import build_all as b  # noqa: E402


class BuildAllTests(unittest.TestCase):
    def test_parse_args_blend_and_default_blender(self):
        a = b.parse_args(["--blend", "X.blend"])
        self.assertEqual(a.blend, "X.blend")
        self.assertEqual(a.blender, "D:/BLENDER/blender.exe")
        self.assertFalse(a.skip_tests)
        self.assertFalse(a.no_bake)

    def test_parse_args_flags(self):
        a = b.parse_args(["--skip-tests", "--no-bake", "--blender", "Z.exe"])
        self.assertTrue(a.skip_tests and a.no_bake)
        self.assertEqual(a.blender, "Z.exe")
        self.assertIsNone(a.blend)

    def test_effective_config_replaces_blend_only(self):
        base = {"blend": "A.blend", "bake_px": 1024, "collision": {"min_size_m": 0.3}}
        out = b.effective_config(base, "X.blend")
        self.assertEqual(out["blend"], "X.blend")
        self.assertEqual(out["bake_px"], 1024)
        self.assertEqual(out["collision"], {"min_size_m": 0.3})
        self.assertEqual(base["blend"], "A.blend")

    def test_effective_config_without_blend_keeps_base(self):
        base = {"blend": "A.blend", "k": 1}
        self.assertEqual(b.effective_config(base, None), base)

    def test_blend_path(self):
        absolute = os.path.abspath(os.path.join("x", "A.blend"))  # absolute on every OS
        self.assertEqual(b.blend_path({"blend": absolute}), absolute)
        self.assertEqual(b.blend_path({"blend": absolute}, "B.blend"), os.path.abspath("B.blend"))

    def test_relative_blend_path_is_relative_to_project_root(self):
        self.assertEqual(b.blend_path({"blend": "CityScene.blend"}), os.path.join(b.ROOT, "CityScene.blend"))

    def test_missing_blend_fails_before_blender(self):
        with mock.patch.object(b, "step") as step:
            with self.assertRaises(SystemExit) as ctx:
                b.main(["--blend", os.path.join(os.path.dirname(__file__), "no_such_file.blend")])
        self.assertIn("not found", str(ctx.exception))
        step.assert_not_called()


REPORT = {"triangles": 10, "collision_triangles": 5, "lights": 3,
          "materials": {"override": 8, "bake": 34, "gltf": 30}, "warnings": 1}
SCENE = {"materials": {"A": "bake", "B": "gltf", "C": "bake"},
         "warnings": ["missing image: x.png (C:\\textures\\x.png)", "sun light Sun: exported as kind sun"]}


class ExportReportTests(unittest.TestCase):
    def test_parse_export_report_takes_the_ok_line(self):
        output = "Blender 5.2\nCS_BAKE pair\nCS_EXPORT_OK " + json.dumps(REPORT) + "\n\nBlender quit\n"
        self.assertEqual(b.parse_export_report(output), REPORT)
        self.assertIsNone(b.parse_export_report("Blender 5.2\nCS_EXPORT_FAILED\n"))

    def test_export_details_routes_from_report_warnings_from_scene(self):
        routes, warnings = b.export_details(REPORT, SCENE)
        self.assertEqual(routes, {"bake": 34, "gltf": 30, "override": 8})
        self.assertEqual(list(routes), ["bake", "gltf", "override"])
        self.assertEqual(warnings, SCENE["warnings"])

    def test_export_details_counts_routes_from_scene_without_report_counts(self):
        routes, warnings = b.export_details({"lights": 1}, SCENE)
        self.assertEqual(routes, {"bake": 2, "gltf": 1})
        self.assertEqual(len(warnings), 2)
        self.assertEqual(b.export_details({}, {}), ({}, []))


def glb(doc, magic=b"glTF"):
    """A GLB header and JSON chunk (no binary chunk) for doc."""
    data = json.dumps(doc).encode("utf-8")
    data += b" " * (-len(data) % 4)
    return magic + struct.pack("<II", 2, 20 + len(data)) + struct.pack("<I4s", len(data), b"JSON") + data


COMPRESSED = {"asset": {"version": "2.0"}, "extensionsUsed": ["EXT_meshopt_compression", "KHR_mesh_quantization"]}
PLAIN = {"asset": {"version": "2.0"}}
OK_REPORT = {"collision_triangles": 516000, "lights": 176}


class ValidationTests(unittest.TestCase):
    def test_parse_glb_head(self):
        magic, doc = b.parse_glb_head(glb(COMPRESSED))
        self.assertEqual(magic, b"glTF")
        self.assertEqual(doc["extensionsUsed"][0], "EXT_meshopt_compression")
        self.assertEqual(b.parse_glb_head(b"PK\x03\x04 not a glb at all"), (b"PK\x03\x04", None))
        self.assertEqual(b.parse_glb_head(glb(PLAIN)[:25]), (b"glTF", None))  # cut off

    def test_read_glb_head_reads_header_and_json_only(self):
        fd, path = tempfile.mkstemp(suffix=".glb")
        with os.fdopen(fd, "wb") as fh:
            fh.write(glb(COMPRESSED) + b"\x00" * 4096)
        self.addCleanup(os.remove, path)
        self.assertEqual(b.read_glb_head(path), (b"glTF", json.loads(json.dumps(COMPRESSED))))

    def test_valid_outputs_pass(self):
        self.assertEqual(b.validate_outputs(b.parse_glb_head(glb(COMPRESSED)), 34_000_000,
                                            b.parse_glb_head(glb(COMPRESSED)), OK_REPORT), [])

    def test_each_problem_is_reported(self):
        city = b.parse_glb_head(glb(COMPRESSED))
        collision = b.parse_glb_head(glb(PLAIN))
        cases = [
            ((b.parse_glb_head(b"<html>404</html>....."), 1000, collision, OK_REPORT), "city.glb is not a GLB"),
            ((city, 1000, b.parse_glb_head(b"\x00\x00\x00\x00junk"), OK_REPORT), "collision.glb is not a GLB"),
            ((b.parse_glb_head(glb(PLAIN)), 1000, collision, OK_REPORT), "not compressed"),
            ((city, 100_000_000, collision, OK_REPORT), "limit is 100 MB"),
            ((city, 1000, collision, {"collision_triangles": 0, "lights": 176}), "no triangles"),
            ((city, 1000, collision, {"collision_triangles": 9, "lights": 0}), "no lights"),
            ((city, 1000, collision, {}), "no triangles"),
        ]
        for arguments, expected in cases:
            problems = b.validate_outputs(*arguments)
            self.assertTrue(any(expected in p for p in problems), (expected, problems))
        self.assertEqual(len(b.validate_outputs(city, 99_999_999, collision, OK_REPORT)), 0)


if __name__ == "__main__":
    unittest.main()
