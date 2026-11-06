import { MapControls, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { SceneData } from "../data/types";
import { toWorld } from "../lib/coords";
import { CAPSULE_HEIGHT_M, EYE_HEIGHT_M, findSpawn, streetLevel, Walker } from "../lib/walker";
import { useApp } from "../store";

const WALK_RADIUS_M = 0.4;
const WALK_SPEED = 3.2;
const RUN_SPEED = 8;
const LOOK_SPEED = 0.0024;
const PITCH_LIMIT = 1.35;
/** A walk spawn may sit at most this far above the street level (kerbs, terraces; not roofs). */
const SPAWN_MAX_RISE_M = 1.5;
/** A long pause (a hidden tab) must not turn into one long walk. */
const MAX_FRAME_S = 0.1;
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

const debugHooks = () => import.meta.env.DEV || location.search.includes("debug");

/** The parts of drei's MapControls/OrbitControls the debug hook touches. */
interface DebugControls {
  target?: THREE.Vector3;
  update: () => void;
}

type LookFn = (x: number, y: number, z: number, yaw: number, pitch: number) => void;

/**
 * The three camera modes: aerial (map-style panning), orbit (slow auto-rotation around the
 * centre) and walk (street level, capsule collision). Ranges and positions come from
 * data.cameras (Blender axes, converted with toWorld). Walk mode needs `collider`.
 * With ?debug, window.__csLook(x, y, z, yaw, pitch) places the camera in three.js axes; in walk
 * mode (x, y, z) is the eye and the walker is moved there.
 */
export function CameraRig({ data, collider }: { data: SceneData; collider: THREE.Mesh | null }) {
  const requested = useApp((state) => state.cameraMode);
  // Walk mode without collision data falls back to the aerial view.
  const mode = requested === "walk" && !collider ? "aerial" : requested;
  const { camera, gl } = useThree();
  const controls = useThree((state) => state.controls) as unknown as DebugControls | null;
  const walkLook = useRef<LookFn | null>(null);

  const center = useMemo(() => toWorld(...data.cameras.center), [data]);
  const aerialTarget = useMemo(() => center.toArray() as [number, number, number], [center]);
  // The orbit turns around the middle of the city at half its height.
  const orbitTarget = useMemo(() => [center.x, (data.bounds.min[2] + data.bounds.max[2]) / 2, center.z] as [number, number, number], [center, data]);

  // Street height, the respawn for a walker that fell out of the scene (a street spot near the
  // centre), and the scene limit the walker stays inside, found once. Where no open spot qualifies,
  // spawns fall back to the respawn, and the respawn to the centre at street level.
  const street = useMemo(() => {
    if (!collider) return null;
    const level = streetLevel(collider);
    const find = (x: number, z: number) =>
      findSpawn(collider, new THREE.Vector3(x, level, z), data.cameras.limit, { radius: WALK_RADIUS_M, height: CAPSULE_HEIGHT_M, maxRise: SPAWN_MAX_RISE_M });
    const respawn = find(center.x, center.z) ?? new THREE.Vector3(center.x, level, center.z);
    const spawn = (x: number, z: number) => find(x, z) ?? respawn.clone();
    const limit = { center: new THREE.Vector3(center.x, level, center.z), half: data.cameras.limit };
    return { level, spawn, respawn, limit };
  }, [collider, data, center]);

  useEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    if (mode === "aerial") {
      toWorld(...data.cameras.aerial.position, camera.position);
      camera.lookAt(center);
      perspective.fov = 42;
    } else if (mode === "orbit") {
      toWorld(...data.cameras.orbit.position, camera.position);
      camera.lookAt(orbitTarget[0], orbitTarget[1], orbitTarget[2]);
      perspective.fov = 42;
    } else {
      perspective.fov = 62;
    }
    perspective.updateProjectionMatrix();
  }, [mode, camera, data, center, orbitTarget]);

  useEffect(() => {
    if (!debugHooks()) return;
    const look: LookFn = (x, y, z, yaw, pitch) => {
      if (walkLook.current) return walkLook.current(x, y, z, yaw, pitch);
      // Aerial and orbit: the view is placed exactly. The controls keep running every frame, so their
      // distance and angle limits are lifted (until the next mode change remounts them) and their
      // target goes 1 m ahead of the camera.
      camera.position.set(x, y, z);
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      if (controls?.target) {
        Object.assign(controls, { minDistance: 0, maxDistance: Infinity, minPolarAngle: 0, maxPolarAngle: Math.PI, autoRotate: false });
        controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion));
        controls.update();
      }
    };
    Object.assign(window, { __csLook: look });
    return () => {
      delete (window as unknown as { __csLook?: unknown }).__csLook;
    };
  }, [camera, controls]);

  if (mode === "aerial") {
    return (
      <MapControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={data.cameras.aerial.min}
        maxDistance={data.cameras.aerial.max}
        maxPolarAngle={Math.PI * 0.46}
        target={aerialTarget}
        domElement={gl.domElement}
      />
    );
  }
  if (mode === "orbit") {
    return (
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        autoRotate
        autoRotateSpeed={0.35}
        minDistance={data.cameras.orbit.min}
        maxDistance={data.cameras.orbit.max}
        maxPolarAngle={Math.PI * 0.49}
        target={orbitTarget}
        domElement={gl.domElement}
      />
    );
  }
  return <WalkControls collider={collider!} street={street!} lookHook={walkLook} />;
}

interface Street {
  level: number;
  spawn: (x: number, z: number) => THREE.Vector3;
  respawn: THREE.Vector3;
  limit: { center: THREE.Vector3; half: [number, number] };
}

function WalkControls({ collider, street, lookHook }: { collider: THREE.Mesh; street: Street; lookHook: MutableRefObject<LookFn | null> }) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>());
  const yaw = useRef(0);
  const pitch = useRef(0);
  const dragging = useRef(false);
  const setPointerLocked = useApp((state) => state.setPointerLocked);
  const walker = useMemo(() => new Walker(collider, { radius: WALK_RADIUS_M, height: CAPSULE_HEIGHT_M, respawn: street.respawn, limit: street.limit }), [collider, street]);
  const move = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    // Start on a clear piece of street, near where the other camera was looking.
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    const reach = look.y < -0.05 ? (camera.position.y - street.level) / -look.y : 0;
    const near = camera.position.clone().addScaledVector(look, reach);
    const spawn = street.spawn(near.x, near.z);
    walker.place(spawn);
    camera.position.set(spawn.x, spawn.y + EYE_HEIGHT_M, spawn.z);
    yaw.current = Math.atan2(-look.x, -look.z);
    pitch.current = 0;

    const element = gl.domElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (MOVE_KEYS.has(event.code)) {
        keys.current.add(event.code);
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    const onBlur = () => keys.current.clear();
    const onPointerDown = () => {
      dragging.current = true;
    };
    const onPointerUp = () => {
      dragging.current = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging.current && document.pointerLockElement !== element) return;
      yaw.current -= event.movementX * LOOK_SPEED;
      pitch.current = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch.current - event.movementY * LOOK_SPEED));
    };
    const onLockChange = () => setPointerLocked(document.pointerLockElement === element);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      keys.current.clear();
      if (document.pointerLockElement === element) document.exitPointerLock();
      setPointerLocked(false);
    };
  }, [camera, gl, street, walker, setPointerLocked]);

  // Automated checks place the walker at fixed spots with ?debug (the eye at x, y, z).
  useEffect(() => {
    if (!debugHooks()) return;
    lookHook.current = (x, y, z, nextYaw, nextPitch) => {
      walker.place(new THREE.Vector3(x, y - EYE_HEIGHT_M, z));
      camera.position.set(x, y, z);
      yaw.current = nextYaw;
      pitch.current = nextPitch;
    };
    const spawnNear = (x: number, z: number) => street.spawn(x, z).toArray();
    Object.assign(window, { __csWalker: walker, __csCollider: collider, __csFindSpawn: spawnNear, __csStreetLevel: street.level });
    return () => {
      lookHook.current = null;
      delete (window as unknown as { __csWalker?: unknown }).__csWalker;
      delete (window as unknown as { __csFindSpawn?: unknown }).__csFindSpawn;
    };
  }, [camera, walker, collider, street, lookHook]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, MAX_FRAME_S);
    const held = keys.current;
    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, "YXZ"));
    const forward = (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) - (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0);
    const strafe = (held.has("KeyD") || held.has("ArrowRight") ? 1 : 0) - (held.has("KeyA") || held.has("ArrowLeft") ? 1 : 0);
    move.set(0, 0, 0);
    if (forward !== 0 || strafe !== 0) {
      const speed = held.has("ShiftLeft") || held.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      const length = Math.hypot(forward, strafe);
      const sin = Math.sin(yaw.current);
      const cos = Math.cos(yaw.current);
      move.set(((-sin * forward + cos * strafe) / length) * speed, 0, ((-cos * forward - sin * strafe) / length) * speed);
    }
    // The walker steps every frame, standing still too, so gravity and ground keep working.
    walker.step(delta, move);
    camera.position.set(walker.feet.x, walker.feet.y + EYE_HEIGHT_M, walker.feet.z);
  });

  return null;
}
