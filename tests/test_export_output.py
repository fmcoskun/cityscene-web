"""Runs the real Blender export (--no-bake, about half a minute) into a temp folder and checks its
outputs; BakedExport runs it twice more with baking into a fresh bake cache (several minutes).

Blender path: env CS_BLENDER, default D:/BLENDER/blender.exe.
"""
import json
import os
import shutil
import struct
import subprocess
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLENDER = os.environ.get("CS_BLENDER", "D:/BLENDER/blender.exe")
CONFIG = os.path.join(ROOT, "config", "export_config.json")
SCRIPT = os.path.join(ROOT, "blender", "export_scene.py")
OVERRIDES = os.path.join(ROOT, "config", "material_overrides.json")
MISSING_IMAGE = "1643399406_1-abrakadabra-fun-p-podteki-tekstura-1.png"
# Materials the exporter hands to glTF as they are. Fixed by the scene, not by the overrides file:
# every used material that is neither glTF-ready nor overridden is baked.
USED_MATERIALS = 72
GLTF_MATERIALS = 30


def load_overrides():
    with open(OVERRIDES, encoding="utf-8") as fh:
        return json.load(fh)


def glb_json(path):
    with open(path, "rb") as fh:
        magic, _version, _length = struct.unpack("<4sII", fh.read(12))
        if magic != b"glTF":
            raise ValueError("not a GLB: %s" % path)
        chunk_len, chunk_type = struct.unpack("<I4s", fh.read(8))
        if chunk_type != b"JSON":
            raise ValueError("first GLB chunk is not JSON: %s" % path)
        return json.loads(fh.read(chunk_len).decode("utf-8"))


class ExportOutputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CONFIG, encoding="utf-8") as fh:
            cls.blend = json.load(fh)["blend"]
        cls.out = tempfile.mkdtemp(prefix="cs_export_")
        cls.mtime_before = os.path.getmtime(cls.blend)
        cls.proc = subprocess.run(
            [BLENDER, "--background", "--factory-startup", "--python", SCRIPT, "--",
             "--config", CONFIG, "--out", cls.out, "--no-bake"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800)
        cls.mtime_after = os.path.getmtime(cls.blend)
        cls.scene = None
        path = os.path.join(cls.out, "data", "scene.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                cls.scene = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def _scene(self):
        if self.scene is None:
            self.fail("export produced no scene.json (exit %s):\n%s\n%s" % (
                self.proc.returncode, self.proc.stdout[-3000:], self.proc.stderr[-3000:]))
        return self.scene

    def test_export_succeeded(self):
        lines = [l for l in self.proc.stdout.splitlines() if l.strip()]
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr[-3000:])
        self.assertTrue(any(l.startswith("CS_EXPORT_OK ") for l in lines[-5:]), self.proc.stdout[-3000:])

    def test_files_exist(self):
        for rel in ("models/city.glb", "models/collision.glb", "data/scene.json"):
            self.assertTrue(os.path.isfile(os.path.join(self.out, rel)), rel)

    def test_blend_untouched(self):
        self.assertEqual(self.mtime_before, self.mtime_after)

    def test_bevel_disabled(self):
        self.assertLess(self._scene()["stats"]["triangles"], 1_000_000)

    def test_lights_and_exclusions(self):
        self.assertEqual(len(self._scene()["lights"]), 176)
        names = {n.get("name") for n in glb_json(os.path.join(self.out, "models", "city.glb")).get("nodes", [])}
        for hidden in ("Lampposts.001", "Lampposts.002", "Lampposts.003"):
            self.assertNotIn(hidden, names)

    def test_glass_stays_collidable(self):
        sources = self._scene()["stats"]["collision_objects"]
        for name in ("BANK.GLASS", "OLD BRICK HOUSE GLASS", "HOUSE GREY.Glass"):
            self.assertIn(name, sources)
        self.assertNotIn("the wire", sources)

    def test_every_used_material_classified(self):
        materials = self._scene()["materials"]
        self.assertEqual(len(materials), USED_MATERIALS)
        overrides = load_overrides()
        for name in overrides:
            self.assertEqual(materials.get(name), "override", name)
        self.assertEqual(sorted(n for n, c in materials.items() if c == "override"), sorted(overrides))
        self.assertEqual(sum(c == "gltf" for c in materials.values()), GLTF_MATERIALS)

    def test_missing_image_is_reported(self):
        self.assertTrue(any(MISSING_IMAGE in w for w in self._scene()["warnings"]), self._scene()["warnings"])

    def test_collision_smaller_than_visual(self):
        stats = self._scene()["stats"]
        self.assertGreater(stats["collision_triangles"], 0)
        self.assertLessEqual(stats["collision_triangles"], stats["triangles"])


def run_export(out, *extra):
    started = time.perf_counter()
    proc = subprocess.run(
        [BLENDER, "--background", "--factory-startup", "--python", SCRIPT, "--",
         "--config", CONFIG, "--out", out] + list(extra),
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3600)
    seconds = time.perf_counter() - started
    report = None
    for line in proc.stdout.splitlines():
        if line.startswith("CS_EXPORT_OK "):
            report = json.loads(line[len("CS_EXPORT_OK "):])
    return proc, report, seconds


class BakedExport(unittest.TestCase):
    """Full export with baking, twice, into a fresh bake cache: the first run bakes every
    (object, material) pair, the second one must take them all from the cache. Takes minutes."""

    @classmethod
    def setUpClass(cls):
        with open(CONFIG, encoding="utf-8") as fh:
            cls.blend = json.load(fh)["blend"]
        cls.work = tempfile.mkdtemp(prefix="cs_bake_")
        cache = os.path.join(cls.work, "cache")
        cls.mtime_before = os.path.getmtime(cls.blend)
        cls.out1 = os.path.join(cls.work, "out1")
        cls.out2 = os.path.join(cls.work, "out2")
        cls.proc1, cls.report1, cls.seconds1 = run_export(cls.out1, "--bake-cache", cache)
        cls.proc2, cls.report2, cls.seconds2 = run_export(cls.out2, "--bake-cache", cache)
        cls.mtime_after = os.path.getmtime(cls.blend)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def _report(self, which):
        proc, report = (self.proc1, self.report1) if which == 1 else (self.proc2, self.report2)
        if report is None:
            self.fail("baked export %d failed (exit %s):\n%s\n%s" % (
                which, proc.returncode, proc.stdout[-3000:], proc.stderr[-3000:]))
        return report

    def test_no_bake_material_left(self):
        self._report(1)
        with open(os.path.join(self.out1, "data", "scene.json"), encoding="utf-8") as fh:
            scene = json.load(fh)
        baked = sorted(n for n, c in scene["materials"].items() if c == "bake")
        self.assertEqual(len(baked), USED_MATERIALS - GLTF_MATERIALS - len(load_overrides()))
        # a material that sits in a slot but is on no face is never drawn, so never exported
        unused = set(scene["stats"]["bake_unused"])
        self.assertLessEqual(len(unused), 2, unused)  # Creamy Brick Tile, LOGO STAR WASH
        gltf = glb_json(os.path.join(self.out1, "models", "city.glb"))
        materials = gltf.get("materials", [])
        for name in baked:
            found = [m for m in materials if m.get("name") == name or m.get("name", "").startswith(name + "@")]
            if name in unused:
                self.assertFalse(found, "unused %r is in the GLB" % name)
                continue
            self.assertTrue(found, "no GLB material for baked %r" % name)
            for mat in found:
                tex = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
                self.assertIsNotNone(tex, mat.get("name"))
                image = gltf["images"][gltf["textures"][tex["index"]]["source"]]
                self.assertTrue(image.get("name", "").startswith("bake_"), (mat.get("name"), image.get("name")))
                if name in scene["stats"]["bake_emissive"]:
                    self.assertIn("emissiveTexture", mat, mat.get("name"))
        self.assertEqual(scene["stats"]["bake_count"], self.report1["bake_count"])
        self.assertEqual(scene["stats"]["bake_cached"], 0)
        self.assertNotIn("bake_seconds", scene["stats"])  # keeps the committed scene.json deterministic

    def test_alpha_materials_not_opaque(self):
        self._report(1)
        gltf = glb_json(os.path.join(self.out1, "models", "city.glb"))
        for name in ("Hurricane Wire Fence", "Metal Mesh Grill"):
            found = [m for m in gltf.get("materials", [])
                     if m.get("name") == name or m.get("name", "").startswith(name + "@")]
            self.assertTrue(found, name)
            for mat in found:
                self.assertNotEqual(mat.get("alphaMode", "OPAQUE"), "OPAQUE", mat.get("name"))

    def test_other_textures_keep_their_uv_map(self):
        """On an object with an atlas bake (BakeUV), a non-baked textured material must not read
        the BakeUV set."""
        self._report(1)
        with open(os.path.join(self.out1, "data", "scene.json"), encoding="utf-8") as fh:
            scene = json.load(fh)
        classes, tiled = scene["materials"], set(scene["stats"]["bake_tiled"])
        gltf = glb_json(os.path.join(self.out1, "models", "city.glb"))
        materials = gltf.get("materials", [])

        def base(mat):
            return mat.get("name", "").split("@")[0]

        def tex_coord(mat):
            tex = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
            return None if tex is None else tex.get("texCoord", 0)

        checked = 0
        for mesh in gltf.get("meshes", []):
            mats = [materials[p["material"]] for p in mesh.get("primitives", []) if "material" in p]
            atlas = {tex_coord(m) for m in mats if classes.get(base(m)) == "bake" and base(m) not in tiled}
            atlas.discard(None)
            for m in mats:
                if atlas and classes.get(base(m)) == "gltf" and tex_coord(m) is not None:
                    self.assertNotIn(tex_coord(m), atlas, (mesh.get("name"), m.get("name")))
                    checked += 1
        self.assertGreater(checked, 0)

    def test_bake_cache_reused(self):
        first, second = self._report(1), self._report(2)
        self.assertGreater(first["bake_count"], 0)
        self.assertEqual(first["bake_cached"], 0)
        self.assertEqual(second["bake_count"], first["bake_count"])
        self.assertEqual(second["bake_cached"], second["bake_count"])
        self.assertLess(self.seconds2, 0.3 * self.seconds1, (self.seconds1, self.seconds2))

    def test_blend_untouched(self):
        self.assertEqual(self.mtime_before, self.mtime_after)


class VisibilityExportTest(unittest.TestCase):
    """Ruling R19 on a tiny synthetic scene (tests/visibility_scene_blender.py; a few seconds):
    objects hidden only in the viewport are exported AND collidable; render-disabled objects are
    in neither the GLB, the collision nor the scene bounds. Sun lights are kind "sun" with a warning."""

    SHOWN = ("Ground", "ViewHidden", "MonitorHidden", "CollViewHidden", "OrphanChild")
    GONE = ("RenderOff", "CollRenderOff", "Excluded")

    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix="cs_visibility_")
        blend = os.path.join(cls.work, "visibility.blend")
        cls.build = subprocess.run(
            [BLENDER, "--background", "--factory-startup", "--python",
             os.path.join(ROOT, "tests", "visibility_scene_blender.py"), "--", "--save", blend],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        cfg = {"blend": blend, "scene": "Scene", "exclude_objects": [], "disable_modifiers": [],
               "texture_max_px": 256, "bake_px": 64, "collision": {"min_size_m": 0.3, "exclude": []},
               "overrides_file": OVERRIDES}
        config = os.path.join(cls.work, "config.json")
        with open(config, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh)
        cls.out = os.path.join(cls.work, "out")
        cls.proc = subprocess.run(
            [BLENDER, "--background", "--factory-startup", "--python", SCRIPT, "--",
             "--config", config, "--out", cls.out, "--no-bake"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        cls.report = None
        for line in cls.proc.stdout.splitlines():
            if line.startswith("CS_EXPORT_OK "):
                cls.report = json.loads(line[len("CS_EXPORT_OK "):])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def _scene(self):
        if self.report is None:
            self.fail("visibility export failed (build exit %s, export exit %s):\n%s\n%s\n%s" % (
                self.build.returncode, self.proc.returncode, self.build.stdout[-1500:],
                self.proc.stdout[-3000:], self.proc.stderr[-3000:]))
        with open(os.path.join(self.out, "data", "scene.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_viewport_hidden_exported_render_disabled_not(self):
        self._scene()
        names = {n.get("name") for n in glb_json(os.path.join(self.out, "models", "city.glb")).get("nodes", [])}
        for name in self.SHOWN:
            self.assertIn(name, names)
        for name in self.GONE:
            self.assertNotIn(name, names)

    def test_viewport_hidden_collidable_render_disabled_not(self):
        sources = set(self._scene()["stats"]["collision_objects"])
        for name in self.SHOWN:
            self.assertIn(name, sources)
        for name in self.GONE:
            self.assertNotIn(name, sources)

    def test_bounds_leave_render_disabled_out(self):
        bounds = self._scene()["bounds"]
        for axis in (0, 1):
            self.assertAlmostEqual(bounds["min"][axis], -20, delta=0.01)
            self.assertAlmostEqual(bounds["max"][axis], 20, delta=0.01)

    def test_report_lists_render_disabled(self):
        self._scene()
        self.assertEqual(sorted(self.report["render_disabled"]), sorted(self.GONE + ("LampOff",)))
        self.assertEqual(self.report["viewport_unhidden"], ["MonitorHidden", "ViewHidden"])

    def test_lights_render_disabled_left_out_sun_warned(self):
        scene = self._scene()
        lights = {light["name"]: light for light in scene["lights"]}
        self.assertEqual(sorted(lights), ["Lamp", "Sun"])
        self.assertEqual(lights["Sun"]["kind"], "sun")
        self.assertEqual(lights["Sun"]["dir"], [0.0, 0.0, -1.0])
        self.assertTrue(any(w.startswith("sun light Sun") for w in scene["warnings"]), scene["warnings"])


class FailedExportTest(unittest.TestCase):
    """A run that fails part-way must leave --out exactly as it was."""

    def test_failure_leaves_out_untouched(self):
        work = tempfile.mkdtemp(prefix="cs_export_fail_")
        try:
            with open(CONFIG, encoding="utf-8") as fh:
                cfg = json.load(fh)
            cfg["scene"] = "No Such Scene"
            cfg["overrides_file"] = OVERRIDES
            bad_config = os.path.join(work, "bad_config.json")
            with open(bad_config, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh)
            out = os.path.join(work, "out")
            markers = {"models/city.glb": b"old city", "data/scene.json": b"old scene"}
            for rel, content in markers.items():
                os.makedirs(os.path.dirname(os.path.join(out, rel)), exist_ok=True)
                with open(os.path.join(out, rel), "wb") as fh:
                    fh.write(content)
            proc = subprocess.run(
                [BLENDER, "--background", "--factory-startup", "--python", SCRIPT, "--",
                 "--config", bad_config, "--out", out, "--no-bake"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
            self.assertNotEqual(proc.returncode, 0, proc.stdout[-2000:])
            self.assertNotIn("CS_EXPORT_OK", proc.stdout)
            found = sorted(os.path.relpath(os.path.join(r, f), out).replace(os.sep, "/")
                           for r, _d, fs in os.walk(out) for f in fs)
            self.assertEqual(found, sorted(markers))
            for rel, content in markers.items():
                with open(os.path.join(out, rel), "rb") as fh:
                    self.assertEqual(fh.read(), content, rel)
            self.assertEqual(sorted(os.listdir(work)), ["bad_config.json", "out"])  # no staging dir left
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
