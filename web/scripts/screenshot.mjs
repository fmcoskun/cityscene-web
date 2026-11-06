// Stills of the production build in the system's Chrome, for checking the look by eye.
//   pnpm --dir web run build
//   pnpm --dir web run screenshot [-- <tag> | --tag <tag>]
// Writes docs/screenshots/<tag>_aerial.png, <tag>_street_<n>.png, material close-ups, then <tag>_orbit.png and a
// walk-mode check (<tag>_walk_*.png: 2 s of W into a wall, the open-front buildings) (tag defaults to task5),
// and prints the renderer, draw stats and any browser errors.
//   node web/scripts/screenshot.mjs --tag day [--light-modes daytime,golden_hour,night]
// The light-mode tour instead (the tag "day" or --light-modes): at 1920x1080 DPR 1, for each light mode the aerial
// view and two street views in walk mode (<tag>_<mode>_aerial.png, <tag>_<mode>_street_<n>.png, steady-meter FPS each),
// and for each first switch to a mode the time until it shows and the longest frame meanwhile; ends back at night.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectErrors, findStreetSpots, findWallApproach, feetOf, fmt, hold, launchChrome, objectBox, openApp, sleep, startPreview, steadyFps, switchLightMode, walkerInside, webRoot } from "./harness.mjs";

const shots = join(webRoot, "..", "docs", "screenshots");
mkdirSync(shots, { recursive: true });
// The tag comes as `--tag <name>` or as the first plain argument.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const tagFlag = args.indexOf("--tag");
const tag = (tagFlag >= 0 ? args[tagFlag + 1] : args.find((arg) => !arg.startsWith("--"))) ?? "task5";
const STREET_VIEWS = 2;
const modesFlag = args.indexOf("--light-modes");
const LIGHT_TOUR = modesFlag >= 0 || tag === "day";
const tourModes = (modesFlag >= 0 && args[modesFlag + 1] && !args[modesFlag + 1].startsWith("--") ? args[modesFlag + 1] : "daytime,golden_hour,night").split(",");
// Close-ups of the override materials, and of image-carrying signs that are baked, one still each.
const CLOSE_UPS = { neon: "NEON STRIP", led: "LED Bulb", glass: "GLASS", glass_transparent: "Glass Transparent", bank_sign: "Commercial bank sign", billboard: "BIG BOARD" };

/**
 * A view of the first mesh using the named material (or a baked copy "<name>@<object>"): from its centre, the horizontal direction
 * with the most open space, up to 7 m out at the centre's height (at least eye height), looking back.
 */
function findCloseUp(materialName) {
  const THREE = window.__csThree;
  const meshes = [];
  let target = null;
  window.__csScene.traverse((node) => {
    if (!node.isMesh) return;
    meshes.push(node);
    if (!target && [node.material].flat().some((material) => material.name === materialName || material.name.startsWith(materialName + "@"))) target = node;
  });
  if (!target) return null;
  const center = new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3());
  const raycaster = new THREE.Raycaster();
  let best = null;
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    raycaster.set(center.clone().addScaledVector(direction, 0.3), direction);
    const hit = raycaster.intersectObjects(meshes.filter((mesh) => mesh !== target), false)[0];
    const room = Math.min(hit ? hit.distance - 0.5 : 7, 7);
    if (!best || room > best.room) best = { room, direction };
  }
  const eye = center.clone().addScaledVector(best.direction, best.room);
  eye.y = Math.max(eye.y, 1.75);
  const look = center.clone().sub(eye);
  const yaw = Math.atan2(-look.x, -look.z);
  const pitch = Math.atan2(look.y, Math.hypot(look.x, look.z));
  return { spot: [eye.x, eye.y, eye.z, yaw, pitch], object: target.name };
}

const OPEN_FRONTS = ["Summer cafe", "GAS staition", "CAR WASH"];
/**
 * The camera modes and the walker in the real scene: orbit and walk views, holding W toward a wall
 * for 2 s (it must stop short of it), and walking into the open-front buildings.
 */
async function walkCheck(page, save) {
  await page.evaluate(() => window.__csApp.getState().setCameraMode("orbit"));
  await sleep(1500);
  await save("orbit");
  const colliderState = await page.evaluate(() => ({ state: window.__csApp.getState().collision, ms: window.__csColliderMs }));
  console.log(`collision: ${colliderState.state}, BVH built in ${colliderState.ms?.toFixed(0)} ms`);
  if (colliderState.state !== "ready") return console.log("walk check skipped: no collider");

  await page.evaluate(() => window.__csApp.getState().setCameraMode("walk"));
  await page.waitForFunction(() => window.__csWalker, undefined, { timeout: 10000 });
  await sleep(1000);
  console.log(`walk spawn: feet ${fmt(await feetOf(page))}, on ground ${await page.evaluate(() => window.__csWalker.onGround)}`);
  await save("walk_spawn");

  // Open street spots from the scene, plus walk spawns on a 12 m grid around the centre.
  const spots = await page.evaluate(findStreetSpots, 8);
  for (let gx = -36; gx <= 36; gx += 12) for (let gz = -36; gz <= 36; gz += 12) {
    const [x, y, z] = await page.evaluate(([px, pz]) => window.__csFindSpawn(px, pz), [gx, gz]);
    spots.push([x, y + 1.75, z]);
  }
  const wall = await page.evaluate(findWallApproach, spots);
  if (!wall) console.log("walk wall check: no street spot with a wall 2-6 m ahead found");
  else {
    await page.evaluate((s) => window.__csLook(...s), wall.spot);
    await sleep(800);
    const start = await feetOf(page);
    await save("walk_start");
    await hold(page, ["w"], 2000);
    const end = await feetOf(page);
    const travelled = (end[0] - start[0]) * wall.direction[0] + (end[2] - start[2]) * wall.direction[2];
    // Signed distance of the walker's axis from the wall plane (positive: still in front of it).
    const gap = (end[0] - wall.point[0]) * wall.normal[0] + (end[2] - wall.point[2]) * wall.normal[2];
    const verdict = gap >= 0.38 && gap < 0.6 ? "STOPPED AT THE WALL" : gap >= 0.6 ? "stopped early" : "WENT THROUGH";
    console.log(`walk wall check: wall ${wall.distance.toFixed(2)} m ahead; held W 2 s: start ${fmt(start)} -> end ${fmt(end)}, moved ${travelled.toFixed(2)} m, axis ${gap.toFixed(2)} m from the wall: ${verdict}`);
    await save("walk_wall");
    // Shift-run back the other way for a second, to see the running speed.
    const before = await feetOf(page);
    await hold(page, ["Shift", "s"], 1000);
    const after = await feetOf(page);
    console.log(`run back 1 s (Shift+S): moved ${Math.hypot(after[0] - before[0], after[2] - before[2]).toFixed(2)} m`);
  }

  for (const name of OPEN_FRONTS) {
    const box = await page.evaluate(objectBox, name);
    if (!box) {
      console.log(`enter "${name}": no such object in the scene`);
      continue;
    }
    const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const reach = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2 + 4;
    let entered = null;
    const tries = [];
    for (let i = 0; i < 8 && !entered; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const spawn = await page.evaluate(([x, z]) => window.__csFindSpawn(x, z), [center[0] + Math.sin(angle) * reach, center[2] + Math.cos(angle) * reach]);
      const yaw = Math.atan2(-(center[0] - spawn[0]), -(center[2] - spawn[2]));
      await page.evaluate(([x, y, z, yw]) => window.__csLook(x, y + 1.75, z, yw, 0), [...spawn, yaw]);
      await sleep(300);
      // Walk toward the middle in short holds, checking after each.
      let state = null;
      for (let k = 0; k < 8; k++) {
        await hold(page, ["w"], 500);
        state = await page.evaluate(walkerInside, box);
        if (state.inside) break;
      }
      tries.push(`from ${fmt(spawn)} -> ${fmt(state.feet)}${state.inPlan ? ` (in plan, ${state.covered ? "covered" : "open sky"})` : ""}`);
      if (state.inside) entered = state;
    }
    if (entered) {
      console.log(`enter "${name}": ENTERED, feet ${fmt(entered.feet)} under cover inside its box ${fmt(box.min)}..${fmt(box.max)}`);
      await save(`walk_${name.toLowerCase().replace(/[^a-z]+/g, "_")}`);
    } else console.log(`enter "${name}": not entered from 8 sides:\n    ${tries.join("\n    ")}`);
  }

  await page.evaluate(() => window.__csApp.getState().setCameraMode("aerial"));
  await sleep(1500);
  await save("aerial_back");
}

/** The light-mode tour: aerial and street views in every mode, with frame times of each first switch. */
async function lightTour(page, save) {
  const spots = await page.evaluate(findStreetSpots, STREET_VIEWS);
  const seen = new Set(["night"]);
  const summary = [];
  for (const mode of tourModes) {
    await page.evaluate(() => window.__csApp.getState().setCameraMode("aerial"));
    await sleep(1500);
    const first = !seen.has(mode);
    seen.add(mode);
    const current = await page.evaluate(() => window.__csApp.getState().activeLightMode);
    if (current !== mode) {
      const result = await page.evaluate(switchLightMode, mode);
      console.log(`switch to ${mode}${first ? " (first)" : ""}: shown after ${result.shownMs.toFixed(0)} ms (loading ${result.prepareMs?.toFixed(0)} ms, shader compile ${result.compileMs?.toFixed(0)} ms, frames held meanwhile), longest frame ${result.worstFrameMs.toFixed(0)} ms`);
      summary.push({ mode, first, ...result });
    }
    const fps = { mode, aerial: await save(`${mode}_aerial`), street: [] };
    await page.evaluate(() => window.__csApp.getState().setCameraMode("walk"));
    await page.waitForFunction(() => window.__csWalker, undefined, { timeout: 10000 }).catch(() => console.log("walk mode unavailable; street views from the aerial camera"));
    for (const [index, spot] of spots.entries()) {
      await page.evaluate((s) => window.__csLook(...s), spot);
      await sleep(1500);
      fps.street.push(await save(`${mode}_street_${index + 1}`));
    }
    summary.push(fps);
  }
  // Back to night for the round trip, as the page opened.
  if ((await page.evaluate(() => window.__csApp.getState().activeLightMode)) !== "night") {
    const back = await page.evaluate(switchLightMode, "night");
    console.log(`back to night: shown after ${back.shownMs.toFixed(0)} ms, longest frame ${back.worstFrameMs.toFixed(0)} ms`);
  }
  const stats = await page.evaluate(() => ({ calls: window.__cs.calls, textures: window.__cs.textures, geometries: window.__cs.geometries, switches: window.__csModes?.switches }));
  console.log(`after the tour: ${JSON.stringify(stats)}`);
  console.log(`light-mode summary: ${JSON.stringify(summary)}`);
}

const stopPreview = await startPreview();
let exitCode = 1;
try {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: LIGHT_TOUR ? { width: 1920, height: 1080 } : { width: 1600, height: 900 } });
    const errors = collectErrors(page);
    // Every animation frame from page load: its time and the draw stats __cs published, plus the moment
    // the loading overlay went away. Shows whether the page stalls right after it looks ready.
    await page.addInitScript(() => {
      const frames = (window.__csFrames = []);
      const tick = (t) => {
        if (window.__csReadyAt === undefined && window.__cs && !document.querySelector(".overlay")) window.__csReadyAt = t;
        if (frames.length < 20000) frames.push([t, window.__cs?.calls ?? -1, window.__cs?.triangles ?? -1]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    console.log(`ready in ${(await openApp(page)).toFixed(1)} s`);
    await sleep(8000);
    const firstSeconds = await page.evaluate(() => {
      const ready = window.__csReadyAt;
      // Up to and including the first frame past 5 s, so a stall crossing the end still shows.
      const all = window.__csFrames.filter(([t]) => t >= ready);
      const end = all.findIndex(([t]) => t >= ready + 5000);
      const after = end < 0 ? all : all.slice(0, end + 1);
      const lines = [];
      let slow = 0;
      for (let i = 1; i < after.length; i++) {
        const dt = after[i][0] - after[i - 1][0];
        // Long frames each get a line; the rest are summarised per second.
        if (dt > 50) lines.push(`  +${(after[i][0] - ready).toFixed(0)} ms: frame took ${dt.toFixed(0)} ms (${after[i][1]} calls, ${after[i][2]} triangles)`);
        if (dt > 50) slow++;
      }
      for (let s = 0; s < 5; s++) {
        const inSecond = after.filter(([t]) => t >= ready + s * 1000 && t < ready + (s + 1) * 1000);
        const last = inSecond.at(-1);
        lines.push(`  second ${s + 1}: ${inSecond.length} frames${last ? `, last ${last[1]} calls ${last[2]} triangles` : ""}`);
      }
      return { lines, slow, frames: after.length };
    });
    console.log(`first 5 s after the overlay went away: ${firstSeconds.frames} frames, ${firstSeconds.slow} longer than 50 ms`);
    console.log(firstSeconds.lines.join("\n"));

    const save = async (name) => {
      const path = join(shots, `${tag}_${name}.png`);
      const fpsValue = await steadyFps(page);
      const stats = await page.evaluate(() => window.__cs);
      await page.screenshot({ path });
      const fps = typeof fpsValue === "number" ? fpsValue.toFixed(0) : "?";
      console.log(`${path}  camera ${JSON.stringify(stats.camera)}  ${stats.calls} calls  ${stats.triangles} triangles  ${fps} FPS`);
      return typeof fpsValue === "number" ? Math.round(fpsValue) : null;
    };
    if (LIGHT_TOUR) {
      const before = await page.evaluate(() => ({ calls: window.__cs.calls, textures: window.__cs.textures, geometries: window.__cs.geometries, renderer: window.__cs.renderer }));
      console.log(`before the tour: ${JSON.stringify(before)}`);
      await lightTour(page, save);
    } else await stills(page, save);
    console.log(errors.length ? `browser errors:\n  ${errors.join("\n  ")}` : "no browser errors");
    exitCode = errors.length ? 1 : 0;
  } finally {
    await browser.close();
  }
} finally {
  stopPreview();
}
process.exit(exitCode);

/** The stills of a normal run: aerial, street views, material close-ups, then the camera-mode and walk check. */
async function stills(page, save) {
  await save("aerial");
  const info = await page.evaluate(() => ({ renderer: window.__cs.renderer, overrides: window.__csOverrides, textures: window.__cs.textures }));
  console.log(`renderer: ${info.renderer}`);
  console.log(`override material slots: ${info.overrides}, textures: ${info.textures}`);

  const spots = await page.evaluate(findStreetSpots, STREET_VIEWS);
  for (const [index, spot] of spots.entries()) {
    await page.evaluate((s) => window.__csLook(...s), spot);
    await sleep(1500);
    console.log(`street ${index + 1}: __csLook(${spot.map((v) => v.toFixed(2)).join(", ")})`);
    await save(`street_${index + 1}`);
  }
  if (spots.length < STREET_VIEWS) console.log(`only ${spots.length} open street spots found`);
  for (const [name, material] of Object.entries(CLOSE_UPS)) {
    const view = await page.evaluate(findCloseUp, material);
    if (!view) {
      console.log(`${name}: no mesh uses "${material}"`);
      continue;
    }
    await page.evaluate((s) => window.__csLook(...s), view.spot);
    await sleep(1000);
    console.log(`${name}: "${material}" on ${view.object}, __csLook(${view.spot.map((v) => v.toFixed(2)).join(", ")})`);
    await save(name);
  }
  await walkCheck(page, save);
}
