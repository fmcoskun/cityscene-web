import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { useApp } from "../store";
import { bloomFor, LIGHT_MODES } from "./lightModes";

/**
 * Bloom spreads over a fixed share of the screen, so a sign a few pixels wide seen from the air
 * gets a halo many times its size (the HOSPITAL sign's red cloud). From the air and in orbit it is
 * kept faint; at street level, where signs are large on screen, it carries the neon look. The
 * strengths come from the light mode (night: 0.15 and 0.5); by day sunlit walls pass the threshold, so it is off.
 */
const RADIUS = 0.4;
/** Only light above white glows: lamps, LEDs and neon, never lit walls or the ground pools. */
const THRESHOLD = 1.0;
/** The canvas' own antialiasing does not reach an offscreen target, so the scene target samples itself. */
const SAMPLES = 4;

/** While above zero, no frame is drawn: the canvas keeps showing the last one. See compileBeforeDrawing. */
let held = 0;

/** Longest wait for a shader compile; a driver that never reports back must not freeze the view. */
export const COMPILE_TIMEOUT_MS = 15000;
/** Spare layer that only the warm-up draws use. */
const WARM_LAYER = 31;
/** Warm-up draws per animation frame stop after this long, so the page stays responsive. */
const WARM_SLICE_MS = 25;

/** Draws the composer's final pass offscreen once, set by the mounted Bloom (its tone mapping is part of its shader). */
let warmOutput: (() => void) | null = null;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** What a program and its vertex layout depend on: one draw per distinct key warms them all. */
function warmKey(object: THREE.Mesh | THREE.Points, material: THREE.Material) {
  const attributes = Object.entries(object.geometry.attributes)
    .map(([name, attribute]) => `${name}:${attribute.itemSize}:${(attribute as THREE.BufferAttribute).array?.constructor.name}:${attribute.normalized}`)
    .sort()
    .join(",");
  return `${material.uuid}|${attributes}|${(object as THREE.InstancedMesh).isInstancedMesh ? "i" : ""}${object.type}`;
}

/**
 * Compiles the scene's shaders while no frame is drawn (gl.compileAsync, which leaves the page
 * running where the driver compiles in parallel), then draws one object per distinct material and
 * vertex layout into a tiny offscreen target of the composer's format, a few per animation frame:
 * Chrome's ANGLE on Direct3D finishes a shader only at its first draw, which otherwise came as one
 * frame of several seconds right after a light-mode switch. The canvas keeps the last frame meanwhile.
 */
export async function compileBeforeDrawing(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const started = performance.now();
  held++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    scene.updateMatrixWorld();
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), COMPILE_TIMEOUT_MS);
    });
    const result = await Promise.race([gl.compileAsync(scene, camera), timedOut]);
    clearTimeout(timer);
    const compileMs = result === "timeout" ? -1 : performance.now() - started;
    const drawStarted = performance.now();
    const drawn = await drawEachProgram(gl, scene, camera);
    warmOutput?.();
    return { compileMs, drawMs: performance.now() - drawStarted, drawn };
  } finally {
    clearTimeout(timer);
    held--;
  }
}

async function drawEachProgram(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const chosen = new Map<string, THREE.Mesh | THREE.Points>();
  const lights: THREE.Light[] = [];
  scene.traverseVisible((node) => {
    if ((node as THREE.Light).isLight) lights.push(node as THREE.Light);
    const object = node as THREE.Mesh | THREE.Points;
    if (!(object as THREE.Mesh).isMesh && !(object as THREE.Points).isPoints) return;
    for (const material of [object.material].flat()) {
      const key = warmKey(object, material);
      if (!chosen.has(key)) chosen.set(key, object);
    }
  });
  const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: SAMPLES });
  target.depthTexture = new THREE.DepthTexture(16, 16, THREE.FloatType);
  const cameraLayers = camera.layers.mask;
  const shadowUpdate = gl.shadowMap.needsUpdate;
  const previousTarget = gl.getRenderTarget();
  const objects = [...new Set(chosen.values())];
  let index = 0;
  try {
    for (const light of lights) light.layers.enable(WARM_LAYER);
    while (index < objects.length) {
      const sliceStarted = performance.now();
      camera.layers.set(WARM_LAYER);
      // The shadow map is drawn by the first real frame, not into the warm-up.
      gl.shadowMap.needsUpdate = false;
      gl.setRenderTarget(target);
      while (index < objects.length && performance.now() - sliceStarted < WARM_SLICE_MS) {
        const object = objects[index++];
        const culled = object.frustumCulled;
        object.frustumCulled = false;
        object.layers.enable(WARM_LAYER);
        gl.render(scene, camera);
        object.layers.disable(WARM_LAYER);
        object.frustumCulled = culled;
      }
      gl.setRenderTarget(previousTarget);
      camera.layers.mask = cameraLayers;
      gl.shadowMap.needsUpdate = shadowUpdate;
      if (index < objects.length) await nextFrame();
    }
  } finally {
    camera.layers.mask = cameraLayers;
    gl.shadowMap.needsUpdate = shadowUpdate;
    gl.setRenderTarget(previousTarget);
    for (const light of lights) light.layers.disable(WARM_LAYER);
    target.depthTexture?.dispose();
    target.dispose();
  }
  return objects.length;
}

/**
 * Bloom around bright lamps and signs. The scene renders into a linear half-float target (the
 * renderer only tone maps when drawing to the screen); OutputPass then applies the renderer's
 * tone mapping and sRGB conversion once, at the end. Priority 1 takes over rendering from R3F.
 */
export function Bloom() {
  const { gl, scene, camera, size } = useThree();
  const dpr = useThree((state) => state.viewport.dpr);
  const cameraMode = useApp((state) => state.cameraMode);
  const lightMode = useApp((state) => state.activeLightMode);

  const composer = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: SAMPLES });
    // A float depth buffer keeps the reversed (or logarithmic) depth as precise as on screen.
    target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    const effects = new EffectComposer(gl, target);
    effects.addPass(new RenderPass(scene, camera));
    effects.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), LIGHT_MODES.night.bloomStrength.aerial, RADIUS, THRESHOLD));
    effects.addPass(new OutputPass());
    return effects;
  }, [gl, scene, camera]);

  useEffect(() => {
    const bloom = composer.passes.find((pass) => pass instanceof UnrealBloomPass);
    if (!bloom) return;
    bloom.strength = bloomFor(LIGHT_MODES[lightMode], cameraMode);
    // A pass at strength 0 would still blur the whole screen five times over.
    bloom.enabled = bloom.strength > 0;
  }, [composer, cameraMode, lightMode]);

  // The final pass rebuilds its shader when the tone mapping changes (daytime ACES, else AgX).
  useEffect(() => {
    const output = composer.passes.find((pass) => pass instanceof OutputPass);
    warmOutput = () => {
      if (!output) return;
      const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
      const toScreen = output.renderToScreen;
      const previous = gl.getRenderTarget();
      output.renderToScreen = false;
      output.render(gl, target, composer.readBuffer, 0, false);
      output.renderToScreen = toScreen;
      // Unbound before it goes, so the renderer keeps no hold on it.
      gl.setRenderTarget(previous);
      target.dispose();
    };
    return () => {
      warmOutput = null;
    };
  }, [composer, gl]);

  useEffect(() => {
    composer.setPixelRatio(dpr);
    composer.setSize(size.width, size.height);
  }, [composer, size, dpr]);

  useEffect(
    () => () => {
      for (const pass of composer.passes) pass.dispose();
      composer.renderTarget1.depthTexture?.dispose();
      composer.renderTarget2.depthTexture?.dispose();
      composer.dispose();
    },
    [composer],
  );

  useFrame((_, delta) => {
    if (held === 0) composer.render(delta);
  }, 1);
  return null;
}
