import { useGLTF, useProgress } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Hud } from "./components/Hud";
import { CameraRig } from "./controls/CameraRig";
import { assetUrl, loadSceneData } from "./data/loadData";
import type { SceneData } from "./data/types";
import { buildCollider } from "./lib/walker";
import { Bloom, COMPILE_TIMEOUT_MS } from "./scene/Bloom";
import { CityModel } from "./scene/CityModel";
import { DaylightRig } from "./scene/DaylightRig";
import { LIGHT_MODES, TONE_MAPPINGS } from "./scene/lightModes";
import { NightLights } from "./scene/NightLights";
import { Sky } from "./scene/Sky";
import { useApp } from "./store";

const debugHooks = () => import.meta.env.DEV || location.search.includes("debug");

/**
 * The view runs from 10 cm to 2 km. A reversed depth buffer keeps that precise at no
 * cost per pixel. Where it is unavailable, the logarithmic buffer does the job more slowly.
 */
function depthOptions() {
  const probe = document.createElement("canvas").getContext("webgl2");
  const reversed = !!probe?.getExtension("EXT_clip_control");
  probe?.getExtension("WEBGL_lose_context")?.loseContext();
  return reversed ? { reversedDepthBuffer: true } : { logarithmicDepthBuffer: true };
}

// Probed once: each probe creates (and drops) a WebGL context.
const DEPTH_OPTIONS = depthOptions();

/**
 * Tone mapping at night (the opening mode): AgX, the successor of the Filmic view transform the
 * scene is rendered with in Blender; against Blender EEVEE stills from the same cameras it gives the
 * closest spread of tones (ACES crushed the shadows and burned the lamps). Exposure chosen by the
 * same comparison. The other light modes set their own (lightModes.ts).
 */
const TONE_MAPPING = TONE_MAPPINGS[LIGHT_MODES.night.toneMapping];
export const TONE_EXPOSURE = LIGHT_MODES.night.exposure;

/** Published for automated checks and the on-screen meter. */
function RendererStats() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    gl.info.autoReset = false;
  }, [gl]);
  useFrame(() => {
    // Automated checks reach inside with ?debug, including on the production build.
    if (debugHooks()) {
      const drawn = window as unknown as { __csDraw?: () => void };
      if (!drawn.__csDraw) drawn.__csDraw = () => gl.render(scene, camera);
      Object.assign(window, { __csScene: scene, __csRenderer: gl, __csCamera: camera, __csThree: THREE, __csApp: useApp });
    }
    (window as unknown as { __cs?: object }).__cs = {
      camera: camera.position.toArray().map((value) => Math.round(value * 100) / 100),
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      renderer: rendererName(gl.getContext()),
    };
    gl.info.reset();
  }, -1);
  return null;
}

function rendererName(context: WebGLRenderingContext | WebGL2RenderingContext) {
  const extension = context.getExtension("WEBGL_debug_renderer_info");
  return extension ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : "bilinmiyor";
}

const COLLISION_URL = assetUrl("models/collision.glb");

/**
 * Loads collision.glb (meshopt + quantized, same loader setup as the city) and bakes it into the
 * walker's BVH collider. Never added to the scene. Lives outside the city's Suspense boundary, so
 * the scene becomes ready without it; a failure only leaves walk mode off.
 */
function CollisionLoader({ onCollider }: { onCollider: (collider: THREE.Mesh) => void }) {
  const gltf = useGLTF(COLLISION_URL, false, true);
  const collider = useMemo(() => {
    const started = performance.now();
    const built = buildCollider(gltf.scene);
    if (debugHooks()) Object.assign(window, { __csColliderMs: performance.now() - started });
    return built;
  }, [gltf]);
  useEffect(() => {
    onCollider(collider);
    useApp.getState().setCollision("ready");
  }, [collider, onCollider]);
  return null;
}

class CollisionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn("Çarpışma verisi yüklenemedi:", error.message);
    useApp.getState().setCollision("failed");
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Loader progress until the city is in place; the city itself declares the scene ready. */
function LoadProgress() {
  const progress = useProgress((state) => state.progress);
  useEffect(() => {
    const app = useApp.getState();
    if (!app.ready) app.setLoadProgress(Math.min(progress / 100, 0.99));
  }, [progress]);
  return null;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Compiles every material in the scene (with the night lights in place, since the light count is
 * part of each shader) and uploads every texture, then lets a few frames draw, all behind the
 * loading overlay. Without it the first frame after loading froze the page for about 5 s.
 * The compile gets COMPILE_TIMEOUT_MS; past that the scene goes on (shaders then finish on first use).
 */
async function warmUp(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  scene.updateMatrixWorld();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), COMPILE_TIMEOUT_MS);
  });
  const compiled = await Promise.race([gl.compileAsync(scene, camera), timedOut]).finally(() => clearTimeout(timer));
  if (compiled === "timeout") console.warn(`Gölgelendirici derlemesi ${COMPILE_TIMEOUT_MS / 1000} s içinde bitmedi; sahne yine de açılıyor.`);
  const textures = new Set<THREE.Texture>();
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.material) return;
    for (const material of [mesh.material].flat()) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const texture of textures) gl.initTexture(texture);
  for (let i = 0; i < 3; i++) await nextFrame();
}

function Scene({ data }: { data: SceneData }) {
  const { gl, scene, camera } = useThree();
  const warming = useRef(false);
  const [collider, setCollider] = useState<THREE.Mesh | null>(null);
  const onLoaded = useCallback(() => {
    if (warming.current) return;
    warming.current = true;
    const ready = () => {
      const app = useApp.getState();
      app.setLoadProgress(1);
      app.setReady();
    };
    // A failed warm-up only costs a stutter later, never the scene.
    warmUp(gl, scene, camera).then(ready, (error: unknown) => {
      console.warn("Gölgelendirici ısıtma başarısız:", error);
      ready();
    });
  }, [gl, scene, camera]);
  return (
    <>
      <RendererStats />
      <CameraRig data={data} collider={collider} />
      <CollisionBoundary>
        <Suspense fallback={null}>
          <CollisionLoader onCollider={setCollider} />
        </Suspense>
      </CollisionBoundary>
      {/* One boundary: the city reports ready only once the sky and the night lights are in place too. */}
      <Suspense fallback={null}>
        <Sky data={data} />
        <NightLights data={data} collider={collider} />
        <CityModel data={data} onLoaded={onLoaded} />
      </Suspense>
      {/* Sun, fill, daytime skies and the mode switch; loads its skies itself, so it never suspends the city. */}
      <DaylightRig data={data} />
      <Bloom />
    </>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    if (this.state.message) return <Failure message={this.state.message} />;
    return this.props.children;
  }
}

function Failure({ message }: { message: string }) {
  return (
    <div className="overlay" role="alert">
      <h1>Sahne yüklenemedi</h1>
      <p>{message}</p>
      <p className="note">Tarayıcınızda WebGL 2 açık olmalıdır. Sayfayı yenileyip yeniden deneyin.</p>
    </div>
  );
}

function LoadingOverlay() {
  const ready = useApp((state) => state.ready);
  const progress = useApp((state) => state.loadProgress);
  if (ready) return null;
  return (
    <div className="overlay" role="status">
      <h1>CityScene</h1>
      <div className="bar" aria-label="Yükleniyor">
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <p className="note">Sahne hazırlanıyor… %{Math.round(progress * 100)}</p>
    </div>
  );
}

export default function App() {
  const fatalError = useApp((state) => state.fatalError);
  const [data, setData] = useState<SceneData | null>(null);

  useEffect(() => {
    loadSceneData().then(setData, (error: Error) => useApp.getState().setFatalError(error.message));
  }, []);

  if (fatalError) return <Failure message={fatalError} />;
  return (
    <ErrorBoundary>
      {/*
        Shadows: only the daytime and golden-hour sun casts any (none at night, so the night shaders
        carry no shadow code). The city does not move, so the map is drawn on demand (DaylightRig),
        not every frame. PCF with a blur radius: three.js 0.187 dropped PCFSoftShadowMap for it.
      */}
      <Canvas
        shadows={{ enabled: true, type: THREE.PCFShadowMap, autoUpdate: false }}
        dpr={[1, 1.5]}
        camera={{ fov: 42, near: 0.1, far: 2000 }}
        // No canvas MSAA: Bloom draws the scene into its own 4x multisampled target and only a
        // full-screen quad reaches the canvas, so antialiasing there would cost memory for nothing.
        gl={{ antialias: false, powerPreference: "high-performance", toneMapping: TONE_MAPPING, toneMappingExposure: TONE_EXPOSURE, ...DEPTH_OPTIONS }}
      >
        {data && <Scene data={data} />}
      </Canvas>
      <LoadProgress />
      <Hud />
      <LoadingOverlay />
    </ErrorBoundary>
  );
}
