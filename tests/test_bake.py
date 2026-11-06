"""Checks blender/bake.py on a tiny in-memory scene inside a background Blender (a few seconds):
cache key invalidation (node mute, image file, modifier settings, transform, UVs), tile vs atlas
routes, atlas size, alpha (MASK) and emission export, original UVs kept for other textures,
cache reuse.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLENDER = os.environ.get("CS_BLENDER", "D:/BLENDER/blender.exe")
SCRIPT = os.path.join(ROOT, "tests", "bake_check_blender.py")

EXPECTED = (
    "digest_changes_on_mute", "digest_changes_on_image_file", "fingerprint_changes",
    "bake_no_warnings", "routes", "alpha_and_emission_found", "atlas_grows_with_area",
    "active_uv_restored", "tile_keeps_original_uv", "tile_png_has_alpha", "tile_alpha_mode",
    "glow_emissive", "plain_texture_keeps_uvmap", "bake_image_prefix", "cache_reused",
)


class BakeUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix="cs_bake_unit_")
        cls.proc = subprocess.run(
            [BLENDER, "--background", "--factory-startup", "--python", SCRIPT, "--", "--work", cls.work],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        cls.results = None
        for line in cls.proc.stdout.splitlines():
            if line.startswith("CS_CHECK "):
                cls.results = json.loads(line[len("CS_CHECK "):])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def test_checks(self):
        if self.results is None:
            self.fail("bake check script failed (exit %s):\n%s\n%s" % (
                self.proc.returncode, self.proc.stdout[-3000:], self.proc.stderr[-3000:]))
        for name in EXPECTED:
            with self.subTest(check=name):
                self.assertIn(name, self.results, self.results)
                ok, detail = self.results[name]
                self.assertTrue(ok, detail)
        crashed = {k: v for k, v in self.results.items() if k.endswith("_crashed")}
        self.assertFalse(crashed, crashed)


if __name__ == "__main__":
    unittest.main()
