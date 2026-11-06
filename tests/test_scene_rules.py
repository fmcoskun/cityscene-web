import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "blender"))
import scene_rules as r  # noqa: E402

OVERRIDES = {"NEON STRIP": {"emission": 5}}


class MaterialTests(unittest.TestCase):
    def test_principled_plain_is_gltf(self):
        s = {"name": "Wall", "surface": "BSDF_PRINCIPLED", "node_types": ["TEX_IMAGE", "NORMAL_MAP"]}
        self.assertEqual(r.classify_material(s, OVERRIDES), "gltf")

    def test_group_is_bake(self):
        s = {"name": "Wall", "surface": "BSDF_PRINCIPLED", "node_types": ["GROUP"]}
        self.assertEqual(r.classify_material(s, OVERRIDES), "bake")

    def test_override_wins(self):
        s = {"name": "NEON STRIP", "surface": "MIX_SHADER", "node_types": []}
        self.assertEqual(r.classify_material(s, OVERRIDES), "override")

    def test_unknown_material_falls_back(self):
        s = {"name": "X", "surface": "MIX_SHADER", "node_types": []}
        self.assertEqual(r.classify_material(s, OVERRIDES), "bake")
        s = {"name": "Y", "surface": "BSDF_PRINCIPLED", "node_types": []}
        self.assertEqual(r.classify_material(s, OVERRIDES), "gltf")


class LightTests(unittest.TestCase):
    def test_point_light_is_watts_over_4pi(self):
        d = r.light_to_web("POINT", 100, (1, 1, 1), None)
        self.assertAlmostEqual(d["intensity"], 100 / (4 * math.pi), places=9)
        self.assertEqual(d["kind"], "point")
        self.assertEqual(d["color"], [1, 1, 1])
        self.assertIsNone(d["angle"])
        self.assertIsNone(d["blend"])

    def test_area_becomes_hemisphere_spot(self):
        d = r.light_to_web("AREA", 10, (1, 0, 0), None)
        self.assertEqual(d["kind"], "spot")
        self.assertAlmostEqual(d["intensity"], 10 / math.pi, places=9)
        self.assertAlmostEqual(d["angle"], math.pi / 2)
        self.assertEqual(d["blend"], 1.0)

    def test_spot_angle_is_half_size_and_keeps_blend(self):
        d = r.light_to_web("SPOT", 10, (1, 1, 1), 1.2, 0.15)
        self.assertEqual(d["kind"], "spot")
        self.assertEqual(d["angle"], 0.6)
        self.assertEqual(d["blend"], 0.15)
        self.assertAlmostEqual(d["intensity"], 10 / (4 * math.pi), places=9)


    def test_sun_is_its_own_kind_not_a_point_light(self):
        d = r.light_to_web("SUN", 3.0, (1, 0.9, 0.8), None)
        self.assertEqual(d["kind"], "sun")
        self.assertEqual(d["intensity"], 3.0)  # strength is irradiance (W/m^2), not watts / 4pi
        self.assertEqual(d["color"], [1, 0.9, 0.8])
        self.assertIsNone(d["angle"])
        self.assertIsNone(d["blend"])


class CollisionTests(unittest.TestCase):
    CFG = {"collision": {"min_size_m": 0.3, "exclude": ["Grass"]}}

    def test_small_objects_do_not_collide(self):
        self.assertFalse(r.collides("Bolt", (0.1, 0.2, 0.25), self.CFG))
        self.assertTrue(r.collides("Building", (5, 5, 10), self.CFG))
        self.assertFalse(r.collides("Grass.001", (5, 5, 10), self.CFG))


class FrameTests(unittest.TestCase):
    def test_frame_contains_scene(self):
        f = r.frame_cameras((-86.5, -70.1, -2.5), (87.7, 69.3, 36.4))
        for got, want in zip(f["center"], (0.6, -0.4, 17)):
            self.assertAlmostEqual(got, want, delta=0.1)
        for got, want in zip(f["limit"], (89.1, 71.7)):
            self.assertAlmostEqual(got, want, delta=0.1)
        self.assertGreater(f["aerial"]["position"][2], 36.4)
        self.assertEqual(f["aerial"]["min"], 10)
        self.assertGreater(f["orbit"]["position"][2], 0)


class ConfigTests(unittest.TestCase):
    def _write(self, data):
        fd, p = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh)
        self.addCleanup(os.remove, p)
        return p

    def test_config_missing_key_names_it(self):
        full = r.load_config(os.path.join(os.path.dirname(__file__), "..", "config", "export_config.json"))
        del full["scene"]
        with self.assertRaises(KeyError) as ctx:
            r.load_config(self._write(full))
        self.assertIn("scene", str(ctx.exception))

    def test_real_config_loads(self):
        c = r.load_config(os.path.join(os.path.dirname(__file__), "..", "config", "export_config.json"))
        self.assertEqual(c["collision"]["min_size_m"], 0.3)


if __name__ == "__main__":
    unittest.main()
