// Shared by scripts/screenshot.mjs and e2e/run.mjs: the preview server, the system Chrome with the GPU on,
// FPS readings, the light-mode switch, and the in-page probes (street spots, a wall to walk into, the walker's state).
// Functions passed to page.evaluate run in the page and may only use what the page has (window.__cs*).
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = 5284;
export const URL_BASE = `http://localhost:${PORT}/`;
const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader=false"];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const fmt = (v) => `(${v.map((n) => n.toFixed(2)).join(", ")})`;

/** Starts `vite preview` of web/dist on PORT and waits until it answers; returns a stop function. */
export async function startPreview() {
  const server = spawn("pnpm", ["run", "preview", "--port", String(PORT), "--strictPort"], { cwd: webRoot, shell: true, stdio: "ignore" });
  // On Windows the preview runs under a shell, so its whole tree has to be stopped.
  const stop = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" }) : server.kill());
  for (let i = 0; i < 120; i++) {
    if (await fetch(URL_BASE).then((r) => r.ok).catch(() => false)) return stop;
    await sleep(250);
  }
  stop();
  throw new Error(`preview server did not answer on ${URL_BASE} within 30 s (is port ${PORT} taken, or is web/dist missing? run pnpm --dir web run build)`);
}

/** The system Chrome (headless, own temporary profile) on the hardware GPU through ANGLE/D3D11. */
export const launchChrome = (extraArgs = []) => chromium.launch({ channel: "chrome", headless: true, args: [...GPU_ARGS, ...extraArgs] });

/** Collects console errors and page errors into the returned array. */
export function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Opens the app with ?debug and waits for the loading overlay to go; returns the seconds it took. */
export async function openApp(page) {
  const started = Date.now();
  await page.goto(URL_BASE + "?debug");
  await page.waitForFunction(() => window.__cs && !document.querySelector(".overlay"), undefined, { timeout: 180000 });
  return (Date.now() - started) / 1000;
}

/**
 * The steady meter: waits until two whole-second readings of the on-screen meter (window.__csFps)
 * in a row agree within 10%, so the value belongs to the view on screen, and returns it.
 */
export async function steadyFps(page) {
  let previous = await page.evaluate(() => window.__csFps);
  for (let i = 0; i < 15; i++) {
    await sleep(1050);
    const current = await page.evaluate(() => window.__csFps);
    if (typeof previous === "number" && typeof current === "number" && Math.abs(current - previous) <= 0.1 * previous) return current;
    previous = current;
  }
  return previous;
}

/** Frames counted in the page for `ms` with requestAnimationFrame: the average FPS and the slowest frame. */
export function averageFps(page, ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const times = [];
        const tick = (t) => {
          times.push(t);
          if (t - times[0] < duration) requestAnimationFrame(tick);
          else {
            let worst = 0;
            for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
            resolve({ fps: ((times.length - 1) * 1000) / (t - times[0]), frames: times.length - 1, worstMs: worst });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** The camera as the page sees it, for blender/render_reference.py: three.js position, quaternion, vertical FOV, canvas size. */
export function cameraPose() {
  const camera = window.__csCamera;
  const canvas = window.__csRenderer.domElement;
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, width: canvas.clientWidth, height: canvas.clientHeight };
}

/**
 * Street spots found in the page: rays straight down onto open ground (no roof above),
 * spread around the centre, each looking toward the centre at eye height.
 */
export async function findStreetSpots(count) {
  const THREE = window.__csThree;
  const data = await (await fetch("data/scene.json")).json();
  // Blender (x, y, z) is three.js (x, z, -y).
  const center = { x: data.cameras.center[0], z: -data.cameras.center[1] };
  const results = [];
  const meshes = [];
  window.__csScene.traverse((node) => node.isMesh && node.visible && meshes.push(node));
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  for (let ring = 12; ring <= 60 && results.length < count; ring += 6) {
    for (let i = 0; i < 16 && results.length < count; i++) {
      const angle = (i / 16) * Math.PI * 2 + ring * 0.37;
      const x = center.x + Math.cos(angle) * ring;
      const z = center.z + Math.sin(angle) * ring;
      raycaster.set(new THREE.Vector3(x, 80, z), down);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (!hit || hit.point.y > 1 || hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y < 0.7) continue;
      // Keep the views apart from one another.
      if (results.some((spot) => Math.hypot(spot[0] - x, spot[2] - z) < 25)) continue;
      const yaw = Math.atan2(-(center.x - x), -(center.z - z));
      results.push([x, hit.point.y + 1.75, z, yaw, 0.08]);
    }
  }
  return results;
}

/**
 * A street spot facing a building wall 2-6 m ahead (reachable in 2 s of walking), measured on the walk collider: horizontal rays
 * at knee, waist and head height, 3 m across, all meet the same near-vertical face, square on (so the
 * walker cannot just slide along it).
 */
export function findWallApproach(spots) {
  const THREE = window.__csThree;
  const bvh = window.__csCollider.geometry.boundsTree;
  const ray = new THREE.Ray();
  for (const [x, eyeY, z] of spots) {
    const feetY = eyeY - 1.75;
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      const direction = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      // A 3 x 3 grid of parallel rays, 3 m wide: a lamppost or a pillar meets only the middle column.
      const side = new THREE.Vector3(direction.z, 0, -direction.x);
      const hits = [];
      for (const h of [1.0, 0.3, 1.6]) {
        for (const offset of [0, -1.5, 1.5]) {
          ray.set(new THREE.Vector3(x, feetY + h, z).addScaledVector(side, offset), direction);
          hits.push(bvh.raycastFirst(ray, THREE.DoubleSide, 0, 20));
        }
      }
      if (hits.some((hit) => !hit)) continue;
      const distance = hits[0].distance;
      if (distance < 2 || distance > 6 || hits.some((hit) => Math.abs(hit.distance - distance) > 0.4)) continue;
      const normal = hits[0].face.normal;
      if (Math.abs(normal.y) > 0.3 || Math.abs(normal.dot(direction)) < 0.95) continue;
      // The wall plane, its normal facing the walker.
      const facing = normal.clone().multiplyScalar(normal.dot(direction) > 0 ? -1 : 1);
      return { spot: [x, eyeY, z, Math.atan2(-direction.x, -direction.z), 0.05], distance, direction: direction.toArray(), point: hits[0].point.toArray(), normal: facing.toArray() };
    }
  }
  return null;
}

/** The bounding box of the visual object called `name` (glTF names have spaces as underscores). */
export function objectBox(name) {
  const THREE = window.__csThree;
  const wanted = [name, name.replace(/ /g, "_")];
  let found = null;
  window.__csScene.traverse((node) => {
    if (!found && (wanted.includes(node.name) || wanted.includes(node.userData?.name))) found = node;
  });
  if (!found) return null;
  const box = new THREE.Box3().setFromObject(found);
  return { min: box.min.toArray(), max: box.max.toArray() };
}

/** Whether the walker's feet are inside the box (plan, shrunk 0.3 m) with something overhead. */
export function walkerInside(box) {
  const THREE = window.__csThree;
  const feet = window.__csWalker.feet;
  const inPlan = feet.x > box.min[0] + 0.3 && feet.x < box.max[0] - 0.3 && feet.z > box.min[2] + 0.3 && feet.z < box.max[2] - 0.3;
  const ray = new THREE.Ray(new THREE.Vector3(feet.x, feet.y + 1.8, feet.z), new THREE.Vector3(0, 1, 0));
  const covered = !!window.__csCollider.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, 15);
  return { inside: inPlan && covered, inPlan, covered, feet: feet.toArray() };
}

export const feetOf = (page) => page.evaluate(() => window.__csWalker.feet.toArray());

/** Holds `keys` for `ms`, then lets go and waits a moment for the walker to settle. */
export async function hold(page, keys, ms) {
  for (const key of keys) await page.keyboard.down(key);
  await sleep(ms);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
  await sleep(300);
}

/**
 * Walks 2 s into a wall found from `spots` (each [x, eyeY, z, ...]); the walker must stop with its axis
 * 0.38-0.6 m from the wall plane (capsule radius 0.4). Leaves the walker there.
 */
export async function wallCheck(page, spots) {
  const wall = await page.evaluate(findWallApproach, spots);
  if (!wall) return { verdict: "NO WALL FOUND" };
  await page.evaluate((s) => window.__csLook(...s), wall.spot);
  await sleep(800);
  const start = await feetOf(page);
  await hold(page, ["w"], 2000);
  const end = await feetOf(page);
  const moved = (end[0] - start[0]) * wall.direction[0] + (end[2] - start[2]) * wall.direction[2];
  // Signed distance of the walker's axis from the wall plane (positive: still in front of it).
  const gap = (end[0] - wall.point[0]) * wall.normal[0] + (end[2] - wall.point[2]) * wall.normal[2];
  const verdict = gap >= 0.38 && gap < 0.6 ? "STOPPED AT THE WALL" : gap >= 0.6 ? "stopped early" : "WENT THROUGH";
  return { verdict, wallDistance: wall.distance, start, end, moved, gap };
}

/**
 * Switches the light mode the way the HUD does and waits until the scene shows it (its sky loaded and
 * its shaders compiled); meanwhile and for 2 s after, every animation frame is timed in the page.
 */
export function switchLightMode(mode) {
  return new Promise((resolve) => {
    const times = [];
    let running = true;
    const tick = (t) => {
      times.push(t);
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const started = performance.now();
    window.__csApp.getState().setLightMode(mode);
    const check = () => {
      if (window.__csApp.getState().activeLightMode !== mode || window.__csModes?.busy) return setTimeout(check, 20);
      const shownMs = performance.now() - started;
      setTimeout(() => {
        running = false;
        let worst = 0;
        for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
        const log = window.__csModes?.switches.at(-1) ?? null;
        resolve({ shownMs, worstFrameMs: worst, frames: times.length, prepareMs: log?.prepareMs, compileMs: log?.compileMs });
      }, 2000);
    };
    check();
  });
}
