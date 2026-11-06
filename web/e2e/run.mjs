// End-to-end check of the production build in the system's Chrome (headless, temporary profile, hardware GPU).
//   pnpm --dir web run build
//   pnpm --dir web run e2e [-- --tag e2e] [--sizes 1600x900,1920x1080] [--seconds 10] [--uncapped] [--compare | --compose] [--report name.json] [--find-spots]
// For each window size (DPR 1): load time, renderer, and per camera mode (aerial, orbit, walk) the average FPS
// over --seconds, draw calls and triangles. In walk mode, stills from three fixed street points (with the
// steady-meter FPS of each). At the first size also: the walk-mode spawn after a mode change, 2 s of W into a
// wall, walking off the scene's edge, and the CityScene.blend mtime against the export's. Writes web/e2e/report.json,
// web/e2e/views.json (the cameras of the stills, for blender/render_reference.py) and docs/screenshots/<tag>_*.png.
// --compare then renders the same views in a background Blender and writes docs/screenshots/compare_*.png
// (web | Blender); --compose makes those from the Blender stills already rendered. --report names the report file. --find-spots only prints street spots found in the scene (to pick STREET_POINTS).
// At 1920x1080 also the light modes (night -> daytime -> golden hour -> night): per mode the steady FPS at the
// street points and stills docs/screenshots/mode_<mode>_{aerial,street}.png, the time and longest frame of each first
// switch, and the checks modeRoundTrip (draw calls and textures back to the opening night, no console error) and
// nightUnchanged (the night street_1 still as bright as before the light modes were added).
// Exits 1 on any browser console error or page error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  averageFps,
  cameraPose,
  collectErrors,
  feetOf,
  findStreetSpots,
  hold,
  launchChrome,
  openApp,
  sleep,
  startPreview,
  steadyFps,
  switchLightMode,
  wallCheck,
  webRoot,
} from "../scripts/harness.mjs";

const projectRoot = join(webRoot, "..");
/**
 * Mean grey (0-255) of the night still at STREET_POINTS[0], 1600x900, from before the light modes: the committed
 * docs/screenshots/e2e_street_1.png of commit 8390a20 (the last e2e run before the day modes). The web half of
 * compare_street_1.png (59.72) is older still and predates later night fixes, so it is not the baseline.
 */
const NIGHT_STREET_1_MEAN = 66.15;
const NIGHT_MEAN_TOLERANCE = 0.5;
const shots = join(projectRoot, "docs", "screenshots");
const e2eDir = join(webRoot, "e2e");
const BLENDER = process.env.BLENDER ?? "D:/BLENDER/blender.exe";
const BLEND = join(projectRoot, "CityScene.blend");

/** Eye positions in three.js axes and the view: [x, y, z, yaw, pitch] for window.__csLook (found once with --find-spots). */
const STREET_POINTS = [
  [3.81, 2.46, 11.97, 0.272, 0.08],
  [3.71, 2.48, -29.42, 3.037, 0.08],
  [-32.22, 1.8, 15.24, -1.146, 0.08],
];

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const tag = option("tag", "e2e");
const seconds = Number(option("seconds", "10"));
const sizes = option("sizes", "1600x900,1920x1080")
  .split(",")
  .map((size) => size.split("x").map(Number));
const compare = args.includes("--compare");
// --compose reuses the Blender stills already in docs/screenshots/reference (same views.json) and only composes.
const compose = args.includes("--compose");
// --uncapped turns off Chrome's vsync and frame limit, so the FPS shows the headroom above the display's 60 Hz.
const uncapped = args.includes("--uncapped");

mkdirSync(shots, { recursive: true });
const report = { date: new Date().toISOString(), tag, seconds, uncapped, sizes: [], checks: {}, errors: [] };
const views = [];
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
/** A path under the project as written in the report: relative, with forward slashes. */
const relative = (path) => path.slice(projectRoot.length + 1).replace(/\\/g, "/");

async function measure(page) {
  const average = await averageFps(page, seconds * 1000);
  const stats = await page.evaluate(() => window.__cs);
  return { fps: round(average.fps), frames: average.frames, worstFrameMs: round(average.worstMs), calls: stats.calls, triangles: stats.triangles, camera: stats.camera };
}

/** Mean grey level (0-255) of an image file. */
async function meanGrey(path) {
  return (await sharp(path).greyscale().stats()).channels[0].mean;
}

/** Draw calls, textures and the console error count at the street point the round trip is measured from. */
async function roundTripSample(page, errors) {
  await page.evaluate((s) => window.__csLook(...s), STREET_POINTS[0]);
  await sleep(1500);
  const stats = await page.evaluate(() => ({ calls: window.__cs.calls, textures: window.__cs.textures, geometries: window.__cs.geometries }));
  return { ...stats, errors: errors.length };
}

/**
 * The light modes at 1080p, in walk mode: from the opening night to daytime, golden hour and back to night.
 * Per mode the steady FPS at the street points and the stills; per first switch the time until it shows and the
 * longest frame meanwhile. Then the round-trip check against the opening night (calls, textures).
 */
async function lightModes(page, errors) {
  const start = await roundTripSample(page, errors);
  const openingNight = await page.screenshot();
  const modes = {};
  for (const mode of ["daytime", "golden_hour", "night"]) {
    const entry = (modes[mode] = {});
    await page.evaluate(() => window.__csApp.getState().setCameraMode("aerial"));
    await sleep(1500);
    const switched = await page.evaluate(switchLightMode, mode);
    entry.switch = { shownMs: round(switched.shownMs, 0), loadMs: round(switched.prepareMs ?? -1, 0), compileMs: round(switched.compileMs ?? -1, 0), worstFrameMs: round(switched.worstFrameMs, 0) };
    console.log(`light mode ${mode}: ${JSON.stringify(entry.switch)}`);
    await sleep(1000);
    await page.screenshot({ path: join(shots, `mode_${mode}_aerial.png`) });
    await page.evaluate(() => window.__csApp.getState().setCameraMode("walk"));
    await page.waitForFunction(() => window.__csWalker, undefined, { timeout: 10000 });
    entry.street = [];
    for (const [index, point] of STREET_POINTS.entries()) {
      await page.evaluate((s) => window.__csLook(...s), point);
      await sleep(1500);
      const steady = await steadyFps(page);
      const stats = await page.evaluate(() => window.__cs);
      if (index === 0) await page.screenshot({ path: join(shots, `mode_${mode}_street.png`) });
      entry.street.push({ look: point, steadyFps: round(steady), calls: stats.calls, triangles: stats.triangles });
    }
    entry.minSteadyFps = Math.min(...entry.street.map((street) => street.steadyFps));
    console.log(`light mode ${mode}: street steady FPS ${entry.street.map((street) => street.steadyFps).join(", ")}`);
    if (mode === "daytime") {
      // Once the sharp sky picture has loaded, the dome must be showing it (a 4096 px picture; the small one is 2048).
      for (let waited = 0; waited <= 15000; waited += 500) {
        entry.skyWidth = await page.evaluate(() => {
          let width = null;
          window.__csScene.traverse((node) => {
            const photo = node.material?.uniforms?.photo?.value;
            if (photo?.image) width = photo.image.width;
          });
          return width;
        });
        if (entry.skyWidth === 4096) break;
        await sleep(500);
      }
      console.log(`daytime sky picture on the dome: ${entry.skyWidth} px wide`);
    }
  }
  const end = await roundTripSample(page, errors);
  const mode = await page.evaluate(() => window.__csApp.getState().activeLightMode);
  const worstFirst = Math.max(...["daytime", "golden_hour"].map((name) => modes[name].switch.worstFrameMs));
  // What the first trip loaded stays by design (the sharp sky, the prefiltered skies); a second trip must add nothing.
  for (const name of ["daytime", "golden_hour", "night"]) await page.evaluate(switchLightMode, name);
  await sleep(1000);
  const again = await roundTripSample(page, errors);
  // The night street frame after the trip against the opening night's, same camera: mean absolute pixel difference.
  const afterNight = await page.screenshot();
  const [before, after] = await Promise.all([openingNight, afterNight].map((png) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  let total = 0;
  for (let i = 0; i < before.data.length; i++) total += Math.abs(before.data[i] - after.data[i]);
  const pixelDifference = total / before.data.length;
  report.checks.nightAfterRoundTrip = { meanAbsDifference: round(pixelDifference, 3), tolerance: NIGHT_MEAN_TOLERANCE, verdict: before.info.width === after.info.width && pixelDifference <= NIGHT_MEAN_TOLERANCE ? "UNCHANGED" : "CHANGED" };
  console.log(`nightAfterRoundTrip: ${JSON.stringify(report.checks.nightAfterRoundTrip)}`);
  const mode2 = await page.evaluate(() => window.__csApp.getState().activeLightMode);
  const diff = { calls: end.calls - start.calls, textures: end.textures - start.textures, geometries: end.geometries - start.geometries };
  const second = { calls: again.calls - end.calls, textures: again.textures - end.textures, geometries: again.geometries - end.geometries };
  const none = (d) => d.calls === 0 && d.textures === 0 && d.geometries === 0;
  report.checks.modeRoundTrip = {
    start,
    afterFirstTrip: end,
    afterSecondTrip: again,
    firstTripDiff: diff,
    secondTripDiff: second,
    activeMode: mode2,
    verdict: mode === "night" && mode2 === "night" && none(second) && Math.abs(diff.calls) <= 2 && Math.abs(diff.textures) <= 6 && again.errors === 0 ? "RESTORED" : "NOT RESTORED",
  };
  report.checks.skySharp = { width: modes.daytime.skyWidth, verdict: modes.daytime.skyWidth === 4096 ? "SHARP SKY SHOWN" : "SMALL SKY STILL SHOWN" };
  report.checks.modeFps1080 = {
    minSteadyFps: Object.fromEntries(Object.entries(modes).map(([name, entry]) => [name, entry.minSteadyFps])),
    renderer: await page.evaluate(() => window.__cs.renderer),
    verdict: "",
  };
  report.modes = modes;
  report.firstSwitchWorstFrameMs = worstFirst;
  console.log(`modeRoundTrip: ${JSON.stringify(report.checks.modeRoundTrip)}`);
}

async function setMode(page, mode) {
  await page.evaluate((m) => window.__csApp.getState().setCameraMode(m), mode);
  if (mode === "walk") await page.waitForFunction(() => window.__csWalker, undefined, { timeout: 10000 });
  await sleep(2500);
}

/**
 * The outermost open street spot in one direction from the centre: walking inward from the fence (the
 * scene limit, or the collider's extent where that is nearer) from 6 m in, in 2 m steps, on lines up
 * to 24 m to either side, the first point where __csFindSpawn keeps the spot it was asked for (within 1.5 m).
 */
async function outermostSpot([dx, dz]) {
  const data = await (await fetch("data/scene.json")).json();
  const center = { x: data.cameras.center[0], z: -data.cameras.center[1] };
  const [hx, hz] = data.cameras.limit;
  const geometry = window.__csCollider.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const radius = window.__csWalker.options.radius;
  // The fence in this direction, as Walker computes it.
  const fence = dx > 0 ? Math.min(center.x + hx, box.max.x - radius) : dx < 0 ? Math.max(center.x - hx, box.min.x + radius) : dz > 0 ? Math.min(center.z + hz, box.max.z - radius) : Math.max(center.z - hz, box.min.z + radius);
  const span = dx !== 0 ? Math.abs(fence - center.x) : Math.abs(fence - center.z);
  for (let inward = 6; inward < span; inward += 2) {
    for (const side of [0, 6, -6, 12, -12, 18, -18, 24, -24]) {
      const x = dx !== 0 ? fence - dx * inward : center.x + side;
      const z = dz !== 0 ? fence - dz * inward : center.z + side;
      const spot = window.__csFindSpawn(x, z);
      if (Math.hypot(spot[0] - x, spot[2] - z) < 1.5) return { spot, fence, limit: dx !== 0 ? center.x + dx * hx : center.z + dz * hz };
    }
  }
  return null;
}

/**
 * The scene's edge, in all four directions: from the outermost open spot, run (Shift+W) straight
 * outward for 8 s. The walker must end inside the limit, on the ground, without having fallen out
 * and been put back (window.__csWalker.respawns stays the same).
 */
async function edgeCheck(page) {
  const results = [];
  for (const [name, dir, yaw] of [["east +x", [1, 0], -Math.PI / 2], ["west -x", [-1, 0], Math.PI / 2], ["south +z", [0, 1], Math.PI], ["north -z", [0, -1], 0]]) {
    const found = await page.evaluate(outermostSpot, dir);
    if (!found) {
      results.push({ direction: name, verdict: "NO OPEN SPOT FOUND" });
      continue;
    }
    const axis = dir[0] !== 0 ? 0 : 2;
    const outward = dir[0] + dir[1];
    await page.evaluate(([x, y, z, w]) => window.__csLook(x, y + 1.75, z, w, 0), [...found.spot, yaw]);
    await sleep(500);
    const respawnsBefore = await page.evaluate(() => window.__csWalker.respawns);
    await hold(page, ["Shift", "w"], 8000);
    await sleep(500);
    const end = await feetOf(page);
    const { onGround, respawns } = await page.evaluate(() => ({ onGround: window.__csWalker.onGround, respawns: window.__csWalker.respawns }));
    const beyond = (end[axis] - found.limit) * outward;
    const shortOfFence = (found.fence - end[axis]) * outward;
    const respawned = respawns !== respawnsBefore;
    const verdict = respawned ? "FELL OUT (RESPAWNED)" : beyond > 1e-3 ? "LEFT THE LIMIT" : !onGround ? "NOT ON GROUND" : shortOfFence < 0.05 ? "STOPPED AT THE EDGE" : "STOPPED BY GEOMETRY BEFORE THE EDGE";
    results.push({ direction: name, start: found.spot, end, limit: round(found.limit, 2), fence: round(found.fence, 2), shortOfFence: round(shortOfFence, 2), ran: round((end[axis] - found.spot[axis]) * outward, 2), onGround, respawned, verdict });
  }
  const failed = results.some((r) => ["FELL OUT (RESPAWNED)", "LEFT THE LIMIT", "NOT ON GROUND"].includes(r.verdict));
  return { directions: results, verdict: failed ? "FAILED" : "STAYED IN THE SCENE" };
}

async function runSize(browser, [width, height], first) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = collectErrors(page);
  const result = { window: `${width}x${height}`, dpr: 1 };
  try {
    result.loadSeconds = round(await openApp(page));
    await sleep(3000);
    Object.assign(result, await page.evaluate(() => ({ renderer: window.__cs.renderer, pixelRatio: window.__csRenderer.getPixelRatio() })));
    result.nvidia = /nvidia/i.test(result.renderer);
    const suffix = first ? "" : `_${height}p`;
    if (args.includes("--find-spots")) {
      console.log(JSON.stringify(await page.evaluate(findStreetSpots, 6)));
      return result;
    }

    result.modes = {};
    for (const mode of ["aerial", "orbit"]) {
      await setMode(page, mode);
      result.modes[mode] = await measure(page);
      if (mode === "aerial" && first) views.push({ name: "aerial", ...(await page.evaluate(cameraPose)) });
      await page.screenshot({ path: join(shots, `${tag}_${mode}${suffix}.png`) });
      console.log(`${result.window} ${mode}: ${JSON.stringify(result.modes[mode])}`);
    }

    await setMode(page, "walk");
    if (first) {
      // The walker was just placed by the mode change: it should stand on open ground.
      const spawnFeet = await feetOf(page);
      const spawnState = await page.evaluate((f) => {
        const THREE = window.__csThree;
        const ray = new THREE.Ray(new THREE.Vector3(f[0], f[1] + 1.8, f[2]), new THREE.Vector3(0, 1, 0));
        return { onGround: window.__csWalker.onGround, roofOverhead: !!window.__csCollider.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, 30) };
      }, spawnFeet);
      report.checks.walkSpawn = { feet: spawnFeet, ...spawnState, verdict: spawnState.onGround && !spawnState.roofOverhead ? "OPEN GROUND" : "NOT OPEN" };
      await page.screenshot({ path: join(shots, `${tag}_walk_spawn.png`) });
    }
    result.modes.walk = await measure(page);
    console.log(`${result.window} walk (spawn): ${JSON.stringify(result.modes.walk)}`);

    result.street = [];
    for (const [index, point] of STREET_POINTS.entries()) {
      await page.evaluate((s) => window.__csLook(...s), point);
      await sleep(1500);
      const name = `street_${index + 1}`;
      const steady = await steadyFps(page);
      const stats = await page.evaluate(() => window.__cs);
      const average = await averageFps(page, 3000);
      await page.screenshot({ path: join(shots, `${tag}_${name}${suffix}.png`) });
      if (first) views.push({ name, ...(await page.evaluate(cameraPose)) });
      result.street.push({ name, look: point, steadyFps: round(steady), fps3s: round(average.fps), calls: stats.calls, triangles: stats.triangles });
      console.log(`${result.window} ${name}: ${JSON.stringify(result.street.at(-1))}`);
    }

    if (first) {
      // The street points, plus walk spawns on a 12 m grid around the centre, as places to look for a wall.
      const spots = [...STREET_POINTS];
      for (let gx = -36; gx <= 36; gx += 12) for (let gz = -36; gz <= 36; gz += 12) {
        const [x, y, z] = await page.evaluate(([px, pz]) => window.__csFindSpawn(px, pz), [gx, gz]);
        spots.push([x, y + 1.75, z]);
      }
      const wall = await wallCheck(page, spots);
      report.checks.wall = wall;
      await page.screenshot({ path: join(shots, `${tag}_walk_wall.png`) });
      console.log(`wall: ${JSON.stringify(wall)}`);
      // Ground following: walking 2 s from a street point keeps the walker on the ground at street level.
      await page.evaluate((s) => window.__csLook(...s), STREET_POINTS[0]);
      await sleep(500);
      const before = await feetOf(page);
      await hold(page, ["w"], 2000);
      const after = await feetOf(page);
      const onGround = await page.evaluate(() => window.__csWalker.onGround);
      report.checks.ground = { before, after, onGround, moved: round(Math.hypot(after[0] - before[0], after[2] - before[2]), 2), verdict: onGround ? "ON GROUND" : "NOT ON GROUND" };
      report.checks.edge = await edgeCheck(page);
      console.log(`ground: ${JSON.stringify(report.checks.ground)}\nedge: ${JSON.stringify(report.checks.edge)}`);
      // The night still at STREET_POINTS[0] (taken above at this size) against the one from before the light modes.
      const mean = await meanGrey(join(shots, `${tag}_street_1${suffix}.png`));
      report.checks.nightUnchanged = { mean: round(mean, 2), before: NIGHT_STREET_1_MEAN, difference: round(Math.abs(mean - NIGHT_STREET_1_MEAN), 2), verdict: Math.abs(mean - NIGHT_STREET_1_MEAN) <= NIGHT_MEAN_TOLERANCE ? "UNCHANGED" : "CHANGED" };
      console.log(`nightUnchanged: ${JSON.stringify(report.checks.nightUnchanged)}`);
    }
    if (width === 1920 && height === 1080) await lightModes(page, errors);
  } finally {
    result.errors = errors;
    report.errors.push(...errors.map((error) => `${result.window}: ${error}`));
    await context.close();
  }
  return result;
}

/** web | Blender, side by side with a label strip, for each view rendered by Blender. */
async function composeComparisons(referenceDir) {
  const made = [];
  for (const view of views) {
    const webShot = join(shots, `${tag}_${view.name}.png`);
    const blenderShot = join(referenceDir, `${view.name}.png`);
    if (!existsSync(webShot) || !existsSync(blenderShot)) continue;
    const { width, height } = view;
    const label = (text) =>
      Buffer.from(
        `<svg width="${width}" height="44"><rect width="100%" height="100%" fill="#111"/><text x="16" y="30" font-family="Segoe UI, Arial" font-size="24" fill="#eee">${text}</text></svg>`,
      );
    const out = join(shots, `compare_${view.name}.png`);
    await sharp({ create: { width: width * 2 + 8, height: height + 44, channels: 3, background: "#000" } })
      .composite([
        { input: label("Web (three.js)"), left: 0, top: 0 },
        { input: label("Blender 5.2 EEVEE (CityScene.blend)"), left: width + 8, top: 0 },
        { input: await sharp(webShot).resize(width, height).toBuffer(), left: 0, top: 44 },
        { input: await sharp(blenderShot).resize(width, height).toBuffer(), left: width + 8, top: 44 },
      ])
      .png()
      .toFile(out);
    made.push(out);
  }
  return made;
}

/**
 * The verdicts each check passes with; any other verdict fails the run (exit code 1). An edge
 * direction stopped by buildings before the limit is not a failure (the edge check's own verdict
 * stays "STAYED IN THE SCENE"), nor is a frame rate measured on a GPU other than NVIDIA.
 */
const PASSING = {
  walkSpawn: ["OPEN GROUND"],
  wall: ["STOPPED AT THE WALL"],
  ground: ["ON GROUND"],
  edge: ["STAYED IN THE SCENE"],
  blendMtime: ["UNCHANGED SINCE EXPORT"],
  fps1080Walk: ["PASS (>= 30)", "NOT COUNTED (renderer is not NVIDIA)"],
  modeRoundTrip: ["RESTORED"],
  nightUnchanged: ["UNCHANGED"],
  nightAfterRoundTrip: ["UNCHANGED"],
  skySharp: ["SHARP SKY SHOWN"],
  modeFps1080: ["PASS (>= 30)", "NOT COUNTED (renderer is not NVIDIA)"],
};

/** "name: verdict" for every check present whose verdict is not a passing one. */
function failedChecks(checks) {
  return Object.entries(PASSING)
    .filter(([name, passing]) => checks[name] && !passing.includes(checks[name].verdict))
    .map(([name]) => `${name}: ${checks[name].verdict}`);
}

const blendMtimeBefore = existsSync(BLEND) ? statSync(BLEND).mtimeMs / 1000 : null;
const stopPreview = await startPreview();
let exitCode = 1;
try {
  const browser = await launchChrome(uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []);
  try {
    for (const [index, size] of sizes.entries()) report.sizes.push(await runSize(browser, size, index === 0));
  } finally {
    await browser.close();
  }
} finally {
  stopPreview();
}

if (!args.includes("--find-spots")) {
  const exported = JSON.parse(readFileSync(join(webRoot, "public", "data", "scene.json"), "utf8")).source;
  report.checks.blendMtime = {
    file: blendMtimeBefore,
    exportedFrom: exported.mtime,
    exportedAt: exported.exported,
    verdict: blendMtimeBefore !== null && Math.abs(blendMtimeBefore - exported.mtime) < 1e-3 ? "UNCHANGED SINCE EXPORT" : "DIFFERS",
  };
  const walk1080 = report.sizes.find((size) => size.window === "1920x1080");
  if (walk1080?.modes) {
    report.checks.fps1080Walk = {
      averageFps: walk1080.modes.walk.fps,
      streetSteadyFps: walk1080.street.map((street) => street.steadyFps),
      renderer: walk1080.renderer,
      verdict: !walk1080.nvidia ? "NOT COUNTED (renderer is not NVIDIA)" : walk1080.modes.walk.fps >= 30 && walk1080.street.every((street) => street.steadyFps >= 30) ? "PASS (>= 30)" : "FAIL (< 30)",
    };
  }
  // The light-mode checks need the 1920x1080 run; without it they fail rather than pass by absence.
  for (const name of ["modeRoundTrip", "nightAfterRoundTrip", "skySharp", "modeFps1080"]) report.checks[name] ??= { verdict: "NOT RUN (1920x1080 is not in --sizes)" };
  if (report.checks.modeFps1080?.minSteadyFps) {
    const fast = Object.values(report.checks.modeFps1080.minSteadyFps).every((fps) => fps >= 30);
    report.checks.modeFps1080.verdict = !walk1080?.nvidia ? "NOT COUNTED (renderer is not NVIDIA)" : fast ? "PASS (>= 30)" : "FAIL (< 30)";
  }
  writeFileSync(join(e2eDir, "views.json"), JSON.stringify(views, null, 2) + "\n");
  const referenceDir = join(shots, "reference");
  if (compose && !compare) report.compare = { reused: "docs/screenshots/reference", images: (await composeComparisons(referenceDir)).map(relative) };
  if (compare) {
    const render = spawnSync(
      BLENDER,
      ["--background", "--factory-startup", BLEND, "--python", join(projectRoot, "blender", "render_reference.py"), "--", "--views", join(e2eDir, "views.json"), "--out", referenceDir],
      { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
    );
    if (render.error) console.error(`Blender reference render failed (${BLENDER}): ${render.error.message}`);
    const lines = (render.stdout ?? "").split(/\r?\n/).filter((line) => line.startsWith("render_reference:"));
    console.log(lines.join("\n"));
    report.compare = { blenderExit: render.status, blenderError: render.error?.message ?? null, log: lines, images: render.status === 0 ? await composeComparisons(referenceDir) : [] };
    report.compare.images = report.compare.images.map(relative);
    const after = statSync(BLEND).mtimeMs / 1000;
    report.checks.blendMtime.afterBlenderRender = after;
    if (after !== blendMtimeBefore) report.checks.blendMtime.verdict = "CHANGED BY THE REFERENCE RENDER";
  }
  report.failedChecks = failedChecks(report.checks);
  const reportFile = join(e2eDir, option("report", "report.json"));
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`report: ${reportFile}`);
}
const failed = report.failedChecks ?? [];
console.log(failed.length ? `failed checks:\n  ${failed.join("\n  ")}` : "all checks passed");
console.log(report.errors.length ? `browser errors:\n  ${report.errors.join("\n  ")}` : "no browser errors");
exitCode = report.errors.length || failed.length ? 1 : 0;
process.exit(exitCode);
