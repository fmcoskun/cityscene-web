// Compress the exported GLBs in place. Run after blender/export_scene.py.
//   pnpm --dir web run optimize-models [-- <models folder>]
// city.glb: weld, dedup (materials kept), textures to WebP at most 2048 px, meshopt.
// collision.glb has no materials or textures: weld and meshopt only.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

// @gltf-transform/functions already loads its own sharp (through ndarray-pixels). Loading our
// sharp as well puts two libvips copies in one process, and every encode then fails with
// "colourspace: parameter space not set". So the encoder is the copy that is already loaded.
const fromFunctions = createRequire(createRequire(import.meta.url).resolve("@gltf-transform/functions"));
const sharp = createRequire(fromFunctions.resolve("ndarray-pixels"))("sharp");

const root = process.argv.slice(2).find((arg) => arg !== "--") ?? fileURLToPath(new URL("../public/models/", import.meta.url));

function glbFiles(folder) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return glbFiles(path);
    return name.endsWith(".glb") ? [path] : [];
  });
}

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
// Every extension is registered, so emission strength, transmission and IOR survive the rewrite.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

const mb = (bytes) => (bytes / 1e6).toFixed(1);
let before = 0;
let after = 0;
let compressed = 0;
const files = glbFiles(root);
for (const path of files) {
  const size = statSync(path).size;
  const document = await io.read(path);
  // A second run would only re-encode the WebP textures and lose quality: compress fresh exports only.
  if (document.getRoot().listExtensionsUsed().some((extension) => extension.extensionName === "EXT_meshopt_compression")) {
    console.log(`${basename(path)}: already compressed, skipped (${mb(size)} MB)`);
    continue;
  }
  const steps = [weld()];
  if (basename(path) !== "collision.glb") {
    steps.push(
      // Materials stay out of dedup: the web app swaps them by name, and plain ones often look identical.
      dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
      textureCompress({ encoder: sharp, targetFormat: "webp", resize: [2048, 2048] }),
    );
  }
  steps.push(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  await document.transform(...steps);
  await io.write(path, document);
  const written = statSync(path).size;
  console.log(`${basename(path)}: ${mb(size)} MB -> ${mb(written)} MB`);
  before += size;
  after += written;
  compressed++;
}
console.log(`${compressed} of ${files.length} files compressed: ${mb(before)} MB -> ${mb(after)} MB`);
