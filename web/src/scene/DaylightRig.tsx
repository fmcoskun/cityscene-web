import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import * as THREE from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { assetUrl } from "../data/loadData";
import type { SceneData } from "../data/types";
import { useApp, type LightMode } from "../store";
import { compileBeforeDrawing } from "./Bloom";
import { applyPreset, chooseSky, findSunAndClamp, LIGHT_MODES, photoRotation, shadowFrustum, softenSky, sunDirection } from "./lightModes";
import { sceneMaterials } from "./materials";
import { domeMaterial, PhotoDome, SkyDome } from "./SkyDome";

/** The photographed sun is far brighter than this. Above it, the sky would light the scene a second time. (AksarayCity) */
const SKY_LIMIT = 12;
/** Light from the generated dome when it stands in for the photographed daytime sky. */
const DOME_FALLBACK_ENVIRONMENT = 0.6;
const SHADOW_MAP_SIZE = 2048;

/** The photographed daytime sky (Poly Haven kloofendal_48d_partly_cloudy_puresky, CC0, from AksarayCity). */
interface PhotoSky {
  /** Image-based light: the HDR with its sun clamped out, prefiltered. */
  environment: THREE.WebGLRenderTarget;
  /** What the camera sees (through PhotoDome): the small picture first, the sharp one once it has loaded. */
  background: THREE.Texture;
  /** Y rotation that puts the photographed sun where the scene's sun is. */
  turn: number;
}

/** Published with ?debug, for the screenshot script and the e2e run. */
interface ModeLog {
  busy: boolean;
  switches: { mode: LightMode; prepareMs: number; compileMs: number; drawMs: number; drawn: number }[];
}
const modeLog: ModeLog = { busy: false, switches: [] };

/** A switch is under way (HUD cue "Işık hazırlanıyor…"), or done. */
function setBusy(busy: boolean) {
  modeLog.busy = busy;
  if (useApp.getState().lightModePending !== busy) useApp.getState().setLightModePending(busy);
}

const loadTexture = (file: string) =>
  new THREE.TextureLoader().loadAsync(assetUrl(file)).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    // Sampled by PhotoDome's shader: mipmaps would draw a seam where the longitude wraps.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  });

/**
 * Sun, fill light and the daytime skies, and the switch between light modes. A switch first loads
 * what the new mode needs (once; everything loaded stays until the scene goes), then shows the
 * mode (store activeLightMode) and compiles the shaders it changed before drawing a frame with them.
 * Night is drawn by Sky and NightLights as before; this adds nothing to it.
 */
export function DaylightRig({ data }: { data: SceneData }) {
  const { gl, scene, camera } = useThree();
  const requested = useApp((state) => state.lightMode);
  const active = useApp((state) => state.activeLightMode);
  const preset = LIGHT_MODES[active];
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const photo = useRef<PhotoSky | null>(null);
  const photoLoad = useRef<Promise<PhotoSky | null> | null>(null);
  const photoFailed = useRef(false);
  const domeEnvironments = useRef(new Map<LightMode, THREE.WebGLRenderTarget>());
  const switchStarted = useRef(0);
  const shown = useRef(false);

  const frustum = useMemo(() => shadowFrustum(data.bounds), [data]);
  const sunTarget = useMemo(() => {
    const target = new THREE.Object3D();
    target.position.copy(frustum.center);
    return target;
  }, [frustum]);
  const sun = useMemo(() => (preset.sun ? sunDirection(preset.sun.elevationDeg, preset.sun.azimuthDeg) : null), [preset]);
  const sky = chooseSky(preset.sky, photoFailed.current);
  const sunLight = useRef<THREE.DirectionalLight>(null);

  /** Loads the photographed sky once; null (and the dome from then on) when any part of it fails. */
  const loadPhoto = () => {
    photoLoad.current ??= (async () => {
      const [hdr, low] = await Promise.allSettled([new HDRLoader().setDataType(THREE.FloatType).loadAsync(assetUrl("textures/sky_env.hdr")), loadTexture("textures/sky_low.webp")]);
      if (hdr.status === "rejected" || low.status === "rejected") {
        console.warn("Gündüz gökyüzü yüklenemedi, üretilmiş gökyüzü kullanılıyor:", hdr.status === "rejected" ? hdr.reason : (low as PromiseRejectedResult).reason);
        if (hdr.status === "fulfilled") hdr.value.dispose();
        if (low.status === "fulfilled") low.value.dispose();
        photoFailed.current = true;
        return null;
      }
      const image = hdr.value.image as unknown as { data: Float32Array; width: number; height: number };
      const photoSun = findSunAndClamp(image.data, image.width, image.height, SKY_LIMIT);
      softenSky(image.data, LIGHT_MODES.daytime.photo?.soften ?? 0);
      hdr.value.mapping = THREE.EquirectangularReflectionMapping;
      hdr.value.needsUpdate = true;
      const pmrem = new THREE.PMREMGenerator(gl);
      const environment = pmrem.fromEquirectangular(hdr.value);
      pmrem.dispose();
      hdr.value.dispose();
      const daySun = LIGHT_MODES.daytime.sun!;
      const loaded: PhotoSky = { environment, background: low.value, turn: photoRotation(photoSun, sunDirection(daySun.elevationDeg, daySun.azimuthDeg)) };
      photo.current = loaded;
      // The sharp picture follows; on failure the small one stays.
      loadTexture("textures/sky_high.webp").then(
        (high) => {
          if (photo.current !== loaded) return high.dispose();
          const low = loaded.background;
          loaded.background = high;
          redraw();
          // Released after the next draw has switched over to the sharp picture.
          requestAnimationFrame(() => requestAnimationFrame(() => low.dispose()));
        },
        (error: unknown) => console.warn("Keskin gökyüzü resmi yüklenemedi:", error),
      );
      return loaded;
    })();
    return photoLoad.current;
  };

  /** The prefiltered dome for a mode's image-based light, made once per mode. */
  const domeEnvironment = (mode: LightMode) => {
    let target = domeEnvironments.current.get(mode);
    const modePreset = LIGHT_MODES[mode];
    if (!target && modePreset.dome && modePreset.sun) {
      const pmrem = new THREE.PMREMGenerator(gl);
      const material = domeMaterial(modePreset.dome, modePreset.sun.color, sunDirection(modePreset.sun.elevationDeg, modePreset.sun.azimuthDeg), 0);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), material);
      const domeScene = new THREE.Scene().add(sphere);
      target = pmrem.fromScene(domeScene as THREE.Scene, 0.02);
      pmrem.dispose();
      sphere.geometry.dispose();
      material.dispose();
      domeEnvironments.current.set(mode, target);
    }
    return target ?? null;
  };

  // A requested mode is shown once its sky is in hand.
  useEffect(() => {
    if (requested === useApp.getState().activeLightMode && !modeLog.busy) return;
    let cancelled = false;
    setBusy(true);
    const started = performance.now();
    const ready = LIGHT_MODES[requested].sky === "photo" ? loadPhoto() : Promise.resolve(null);
    const show = () => {
      if (cancelled) return;
      switchStarted.current = started;
      if (useApp.getState().activeLightMode === requested) setBusy(false);
      else useApp.getState().setActiveLightMode(requested);
    };
    ready.then(show, (error: unknown) => {
      // PMREM or the sun search failed: the generated dome stands in for the photographed sky.
      console.warn("Gündüz gökyüzü hazırlanamadı, üretilmiş gökyüzü kullanılıyor:", error);
      photoFailed.current = true;
      photoLoad.current = Promise.resolve(null);
      show();
    });
    return () => {
      cancelled = true;
    };
  }, [requested]);

  // R3F sets the shadow-camera-* props but leaves the projection as it was (three's 10 m default box).
  useLayoutEffect(() => {
    sunLight.current?.shadow.camera.updateProjectionMatrix();
  });

  // Sky, light and the rest of the mode, before the next frame; then its shaders, before it is drawn.
  useLayoutEffect(() => {
    let background: THREE.Texture | null = null;
    let environment: THREE.Texture | null = null;
    if (sky === "photo" && photo.current) {
      // The picture itself is drawn by PhotoDome, with ground below the horizon.
      environment = photo.current.environment.texture;
      scene.background = null;
      scene.environment = environment;
      scene.environmentIntensity = preset.environment ?? 1;
      scene.environmentRotation.set(0, photo.current.turn, 0);
    } else if (sky === "dome") {
      environment = domeEnvironment(active)?.texture ?? null;
      scene.background = null;
      scene.environment = environment;
      scene.environmentIntensity = preset.sky === "dome" ? (preset.environment ?? 1) : DOME_FALLBACK_ENVIRONMENT;
      scene.environmentRotation.set(0, 0, 0);
    }
    // Night: Sky.tsx owns background and environment.
    return () => {
      // Only what this effect set is reset; Sky sets the night values after this.
      if (sky === "night") return;
      if (scene.background === background) scene.background = null;
      if (scene.environment === environment) scene.environment = null;
      scene.backgroundIntensity = 1;
      scene.environmentIntensity = 1;
      scene.backgroundRotation.set(0, 0, 0);
      scene.environmentRotation.set(0, 0, 0);
    };
  });

  // Tone mapping, fog and the glow of materials; then the shaders, compiled while no frame is drawn.
  useLayoutEffect(() => {
    applyPreset({ renderer: gl, scene, bloom: null, materials: sceneMaterials(scene) }, preset, useApp.getState().cameraMode);
    gl.shadowMap.needsUpdate = preset.shadows;
    if (!shown.current) {
      // The opening night: the loading screen's warm-up compiles it.
      shown.current = true;
      return;
    }
    const prepareMs = performance.now() - switchStarted.current;
    let cancelled = false;
    compileBeforeDrawing(gl, scene, camera).then(
      ({ compileMs, drawMs, drawn }) => {
        if (compileMs < 0) console.warn("Işık modu gölgelendiricileri zamanında derlenemedi; ilk karelerde takılma olabilir.");
        modeLog.switches.push({ mode: active, prepareMs, compileMs, drawMs, drawn });
        gl.shadowMap.needsUpdate = preset.shadows;
        if (!cancelled && useApp.getState().lightMode === active) setBusy(false);
      },
      (error: unknown) => {
        // A failed warm-up only costs a stutter on the first frames, never the mode.
        console.warn("Işık modu ısıtma başarısız:", error);
        gl.shadowMap.needsUpdate = preset.shadows;
        if (!cancelled && useApp.getState().lightMode === active) setBusy(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gl, scene, camera, preset, active]);

  useEffect(() => {
    if (import.meta.env.DEV || location.search.includes("debug")) Object.assign(window, { __csModes: modeLog });
  }, []);

  // Everything loaded for the day modes goes with the scene, not with a mode switch.
  useEffect(
    () => () => {
      photo.current?.environment.dispose();
      photo.current?.background.dispose();
      photo.current = null;
      for (const target of domeEnvironments.current.values()) target.dispose();
      domeEnvironments.current.clear();
    },
    [],
  );

  if (!preset.sun || !sun) return null;
  return (
    <>
      {sky === "photo" && photo.current && preset.photo && (
        <PhotoDome texture={photo.current.background} turn={photo.current.turn} intensity={preset.photo.background} ground={preset.photo.ground} haze={preset.fog?.color ?? preset.photo.ground} />
      )}
      {sky === "dome" && preset.dome && <SkyDome dome={preset.dome} sunColor={preset.sun.color} sunDirection={sun} />}
      {preset.hemi.intensity > 0 && <hemisphereLight args={[preset.hemi.sky, preset.hemi.ground, preset.hemi.intensity]} />}
      <primitive object={sunTarget} />
      {/* One fixed shadow box over the whole scene (it does not follow the camera); drawn on demand. */}
      <directionalLight
        ref={sunLight}
        color={preset.sun.color}
        intensity={preset.sun.intensity}
        position={frustum.center.clone().addScaledVector(sun, frustum.distance)}
        target={sunTarget}
        castShadow={preset.shadows}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-camera-left={frustum.left}
        shadow-camera-right={frustum.right}
        shadow-camera-top={frustum.top}
        shadow-camera-bottom={frustum.bottom}
        shadow-camera-near={frustum.near}
        shadow-camera-far={frustum.far}
        shadow-bias={-0.0005}
        shadow-normalBias={0.08}
        shadow-radius={3}
      />
    </>
  );
}
