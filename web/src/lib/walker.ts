import * as THREE from "three";
import { MeshBVH, type ExtendedTriangle } from "three-mesh-bvh";

// A street-level walker: a vertical capsule pushed out of the collision mesh, after the
// three-mesh-bvh character movement example, with step-ups and ground snapping on top.
// Everything here is in three.js world axes (y up), metres and seconds.

/** Where the walk camera's eye sits above the feet. */
export const EYE_HEIGHT_M = 1.75;
/**
 * The capsule reaches this far above the eye, so a ceiling stops the walker before it comes
 * within the camera's near plane of the eye (a 1.85 m lintel blocks, the eye never pokes through).
 */
export const HEAD_CLEARANCE_M = 0.15;
export const CAPSULE_HEIGHT_M = EYE_HEIGHT_M + HEAD_CLEARANCE_M;

export interface WalkerOptions {
  radius: number;
  /** Capsule height, feet to the top of the head (default CAPSULE_HEIGHT_M, above the eye). */
  height: number;
  /** The highest ledge the walker steps up onto without jumping. */
  stepHeight: number;
  gravity: number;
  /** Feet below this height count as fallen out of the scene. */
  minY: number;
  /** Where a walker that fell out of the scene starts again. */
  respawn: THREE.Vector3;
  /**
   * Plan bounds the walker never leaves: x within half[0] and z within half[1] of `center`
   * (the scene limit). The collider's own plan bounds, shrunk by the radius, are applied too, so
   * a limit wider than the ground cannot walk the walker off its edge. null: only the collider's.
   */
  limit: { center: THREE.Vector3; half: [number, number] } | null;
}

/** Longest stretch of one frame simulated in one go. */
const SUBSTEP_S = 0.05;
/** Surfaces at least this level (normal y) are ground; steeper ones are walls. */
const WALKABLE_NORMAL_Y = 0.7;
/** Fastest fall, so a long drop stays a series of short moves. */
const TERMINAL_SPEED = 50;
const PUSH_ITERATIONS = 3;

/**
 * Bakes every mesh under `root` into one world-space, plain Float32 triangle soup with a BVH.
 * Quantized (KHR_mesh_quantization) and normalized attributes read back through
 * fromBufferAttribute, which denormalizes, and the node world matrices undo the quantization scale.
 */
export function buildCollider(root: THREE.Object3D): THREE.Mesh {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute("position")) meshes.push(mesh);
  });
  let vertexCount = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute("position").count;
    vertexCount += count;
    indexCount += mesh.geometry.index ? mesh.geometry.index.count : count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const vertex = new THREE.Vector3();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positions.set([vertex.x, vertex.y, vertex.z], (vertexOffset + i) * 3);
    }
    const index = mesh.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) indices[indexOffset++] = vertexOffset + index.getX(i);
    else for (let i = 0; i < position.count; i++) indices[indexOffset++] = vertexOffset + i;
    vertexOffset += position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Cast: drei pulls in an older three-mesh-bvh whose BufferGeometry.boundsTree typing differs.
  (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = new MeshBVH(geometry);
  geometry.computeBoundingBox();
  const collider = new THREE.Mesh(geometry);
  collider.name = "collider";
  return collider;
}

function bvhOf(collider: THREE.Mesh): MeshBVH {
  const bvh = (collider.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree;
  if (!bvh) throw new Error("collider has no boundsTree; build it with buildCollider");
  return bvh;
}

function boundsOf(collider: THREE.Mesh): THREE.Box3 {
  if (!collider.geometry.boundingBox) collider.geometry.computeBoundingBox();
  return collider.geometry.boundingBox!;
}

/** Shared scratch objects; the walker never runs two queries at once. */
const segment = new THREE.Line3();
const queryBox = new THREE.Box3();
const trianglePoint = new THREE.Vector3();
const capsulePoint = new THREE.Vector3();
const pushDirection = new THREE.Vector3();
const ray = new THREE.Ray();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

function capsuleSegment(feet: THREE.Vector3, radius: number, height: number) {
  segment.start.set(feet.x, feet.y + radius, feet.z);
  segment.end.set(feet.x, feet.y + height - radius, feet.z);
}

/**
 * Pushes a capsule standing on `feet` out of every triangle it overlaps (moving `feet`).
 * Returns whether anything was touched.
 */
function pushOut(bvh: MeshBVH, feet: THREE.Vector3, radius: number, height: number): boolean {
  let touched = false;
  for (let pass = 0; pass < PUSH_ITERATIONS; pass++) {
    capsuleSegment(feet, radius, height);
    queryBox.makeEmpty().expandByPoint(segment.start).expandByPoint(segment.end);
    queryBox.min.addScalar(-radius);
    queryBox.max.addScalar(radius);
    let pushed = false;
    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(queryBox),
      intersectsTriangle: (triangle: ExtendedTriangle) => {
        const distance = triangle.closestPointToSegment(segment, trianglePoint, capsulePoint);
        if (distance >= radius) return false;
        if (distance > 1e-6) pushDirection.subVectors(capsulePoint, trianglePoint).divideScalar(distance);
        else triangle.getNormal(pushDirection);
        const depth = radius - distance;
        segment.start.addScaledVector(pushDirection, depth);
        segment.end.addScaledVector(pushDirection, depth);
        pushed = true;
        return false;
      },
    });
    if (!pushed) break;
    touched = true;
    feet.set(segment.start.x, segment.start.y - radius, segment.start.z);
  }
  return touched;
}

/** Whether a capsule standing on `feet` overlaps any triangle. */
function overlaps(bvh: MeshBVH, feet: THREE.Vector3, radius: number, height: number): boolean {
  capsuleSegment(feet, radius, height);
  queryBox.makeEmpty().expandByPoint(segment.start).expandByPoint(segment.end);
  queryBox.min.addScalar(-radius);
  queryBox.max.addScalar(radius);
  return bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(queryBox),
    intersectsTriangle: (triangle: ExtendedTriangle) => triangle.closestPointToSegment(segment, trianglePoint, capsulePoint) < radius,
  });
}

/** First hit straight down from `origin` within `far`, or null. */
function castDown(bvh: MeshBVH, origin: THREE.Vector3, far: number) {
  ray.origin.copy(origin);
  ray.direction.copy(DOWN);
  return bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
}

const footprintOrigin = new THREE.Vector3();

/**
 * The highest walkable ground under the walker's footprint (its axis and a ring inside the
 * capsule rim) between `top` and `bottom`, or null. A walker half over a kerb still stands on it.
 */
function groundUnder(bvh: MeshBVH, x: number, z: number, top: number, bottom: number, radius: number): number | null {
  let best: number | null = null;
  const ring = radius * 0.95;
  for (let i = -1; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const offset = i < 0 ? 0 : ring;
    footprintOrigin.set(x + Math.cos(angle) * offset, top, z + Math.sin(angle) * offset);
    const hit = castDown(bvh, footprintOrigin, top - bottom);
    if (!hit?.face || Math.abs(hit.face.normal.y) < WALKABLE_NORMAL_Y) continue;
    if (best === null || hit.point.y > best) best = hit.point.y;
  }
  return best;
}

export class Walker {
  readonly feet = new THREE.Vector3();
  onGround = false;
  /** How many times the walker fell out of the scene and was put back (read by automated checks). */
  respawns = 0;
  readonly options: WalkerOptions;
  private readonly bvh: MeshBVH;
  private verticalSpeed = 0;
  // Scratch vectors for one substep.
  private readonly start = new THREE.Vector3();
  private readonly flat = new THREE.Vector3();
  private readonly raised = new THREE.Vector3();
  private readonly stepped = new THREE.Vector3();
  /** The plan box the feet are kept inside: [minX, maxX, minZ, maxZ]. */
  private readonly fence: [number, number, number, number];

  constructor(collider: THREE.Mesh, options: Partial<WalkerOptions> = {}) {
    this.bvh = bvhOf(collider);
    const bounds = boundsOf(collider);
    this.options = { radius: 0.4, height: CAPSULE_HEIGHT_M, stepHeight: 0.45, gravity: 9.81, minY: bounds.min.y - 10, respawn: new THREE.Vector3(), limit: null, ...options };
    const { radius, limit } = this.options;
    this.fence = [bounds.min.x + radius, bounds.max.x - radius, bounds.min.z + radius, bounds.max.z - radius];
    if (limit) {
      this.fence[0] = Math.max(this.fence[0], limit.center.x - limit.half[0]);
      this.fence[1] = Math.min(this.fence[1], limit.center.x + limit.half[0]);
      this.fence[2] = Math.max(this.fence[2], limit.center.z - limit.half[1]);
      this.fence[3] = Math.min(this.fence[3], limit.center.z + limit.half[1]);
    }
  }

  /** Keeps a plan position inside the fence (the scene limit and the collider's extent). */
  private keepInside(point: THREE.Vector3) {
    const [minX, maxX, minZ, maxZ] = this.fence;
    point.x = THREE.MathUtils.clamp(point.x, minX, maxX);
    point.z = THREE.MathUtils.clamp(point.z, minZ, maxZ);
  }

  /** Puts the walker at `feet` at rest, as on (re)entering walk mode. */
  place(feet: THREE.Vector3) {
    this.feet.copy(feet);
    this.verticalSpeed = 0;
    this.onGround = false;
  }

  /** Advances `delta` seconds with `move` the horizontal velocity in m/s (its y is ignored). */
  step(delta: number, move: THREE.Vector3) {
    const { radius } = this.options;
    let remaining = Math.max(0, delta);
    while (remaining > 1e-9) {
      const dt = Math.min(SUBSTEP_S, remaining);
      remaining -= dt;
      // Within a substep, no single move may cover more than half the radius, or the push-out
      // could resolve to the far side of a thin wall.
      const speed = Math.max(Math.hypot(move.x, move.z), Math.abs(this.verticalSpeed) + this.options.gravity * dt);
      const pieces = Math.max(1, Math.ceil((speed * dt) / (radius * 0.5)));
      for (let i = 0; i < pieces; i++) this.substep(dt / pieces, move);
    }
  }

  private substep(dt: number, move: THREE.Vector3) {
    const { radius, height, stepHeight, gravity, minY, respawn } = this.options;
    const bvh = this.bvh;
    const start = this.start.copy(this.feet);

    // Horizontal: move, push out; if a ledge blocks the way, try again lifted by a step.
    const dx = move.x * dt;
    const dz = move.z * dt;
    const wanted = Math.hypot(dx, dz);
    if (wanted > 1e-9) {
      const progress = (point: THREE.Vector3) => ((point.x - start.x) * dx + (point.z - start.z) * dz) / wanted;
      const flat = this.flat.set(start.x + dx, start.y, start.z + dz);
      pushOut(bvh, flat, radius, height);
      let next = flat;
      if (this.onGround && progress(flat) < wanted * 0.5) {
        const raised = this.raised.set(start.x, start.y + stepHeight, start.z);
        // Only with room overhead for the lifted capsule.
        if (!overlaps(bvh, raised, radius, height)) {
          raised.x += dx;
          raised.z += dz;
          pushOut(bvh, raised, radius, height);
          if (progress(raised) > progress(flat) + 1e-4) {
            const ground = groundUnder(bvh, raised.x, raised.z, raised.y, start.y - stepHeight, radius);
            if (ground !== null && ground <= start.y + stepHeight + 1e-3) {
              const stepped = this.stepped.set(raised.x, ground, raised.z);
              if (!overlaps(bvh, stepped, radius, height)) next = stepped;
            }
          }
        }
      }
      this.keepInside(next);
      this.feet.copy(next);
    }

    // Vertical: gravity, then land on ground under the footprint. A walker that was on the
    // ground follows it down by up to a step (stairs, kerbs, slopes) instead of falling.
    this.verticalSpeed = Math.max(this.verticalSpeed - gravity * dt, -TERMINAL_SPEED);
    const fallTo = this.feet.y + this.verticalSpeed * dt;
    const reach = this.onGround ? Math.max(this.feet.y - fallTo, stepHeight) : this.feet.y - fallTo;
    const ground = this.verticalSpeed <= 0 ? groundUnder(bvh, this.feet.x, this.feet.z, this.feet.y + 0.1, this.feet.y - reach - 1e-4, radius) : null;
    if (ground !== null) {
      this.feet.y = ground;
      this.verticalSpeed = 0;
      this.onGround = true;
    } else {
      this.feet.y = fallTo;
      this.onGround = false;
    }
    // Walls, ceilings and anything the footprint rays missed.
    const before = this.feet.y;
    if (pushOut(bvh, this.feet, radius, height)) {
      const lifted = this.feet.y - before;
      if (lifted > 1e-6 && this.verticalSpeed < 0) {
        this.verticalSpeed = 0;
        this.onGround = true;
      } else if (lifted < -1e-6 && this.verticalSpeed > 0) this.verticalSpeed = 0;
    }

    this.keepInside(this.feet);

    if (this.feet.y < minY) {
      this.feet.copy(respawn);
      this.verticalSpeed = 0;
      this.onGround = false;
      this.respawns++;
    }
  }
}

const SEARCH_RADIUS_M = 80;
const RING_STEP_M = 2;
const DIRECTIONS = 16;
const HEADROOM_M = 2;
const SPAWN_LIFT_M = 0.05;

/**
 * An open piece of street near `near`, searched in rings 2 m apart (16 directions, up to 80 m),
 * inside `limit` (plan half extents around the collider's centre). The spot is the first surface a
 * ray from above the scene meets, so it is under open sky; it must be level, free of walls for the
 * capsule, with 2 m of headroom, and have no other floor far below it (so roofs do not count).
 * With `maxRise`, the spot may be at most that much above `near.y`: a solid block exported without
 * a floor under it has nothing below its roof, so only the height gives that roof away.
 * Returns null when nothing qualifies (the caller picks its own fallback).
 */
export function findSpawn(
  collider: THREE.Mesh,
  near: THREE.Vector3,
  limit: [number, number],
  options: Partial<Pick<WalkerOptions, "radius" | "height">> & { maxRise?: number } = {},
): THREE.Vector3 | null {
  const radius = options.radius ?? 0.4;
  const height = options.height ?? CAPSULE_HEIGHT_M;
  const highest = near.y + (options.maxRise ?? Infinity);
  const bvh = bvhOf(collider);
  const bounds = boundsOf(collider);
  const center = bounds.getCenter(new THREE.Vector3());
  const top = bounds.max.y + 5;
  const far = top - bounds.min.y + 1;
  const origin = new THREE.Vector3();
  const feet = new THREE.Vector3();

  const spotAt = (x: number, z: number): THREE.Vector3 | null => {
    if (Math.abs(x - center.x) > limit[0] || Math.abs(z - center.z) > limit[1]) return null;
    origin.set(x, top, z);
    ray.origin.copy(origin);
    ray.direction.copy(DOWN);
    const hits = bvh.raycast(ray, THREE.DoubleSide, 0, far).sort((a, b) => a.distance - b.distance);
    const first = hits[0];
    if (!first?.face || first.face.normal.y < WALKABLE_NORMAL_Y || first.point.y > highest) return null;
    // A roof: another upward-facing floor lies more than a storey below.
    if (hits.some((hit) => hit.face && hit.face.normal.y >= WALKABLE_NORMAL_Y && first.point.y - hit.point.y > height)) return null;
    feet.set(x, first.point.y + SPAWN_LIFT_M, z);
    if (overlaps(bvh, feet, radius, height)) return null;
    ray.origin.copy(feet);
    ray.direction.copy(UP);
    if (bvh.raycastFirst(ray, THREE.DoubleSide, 0, HEADROOM_M)) return null;
    return new THREE.Vector3(x, first.point.y, z);
  };

  for (let ring = 0; ring <= SEARCH_RADIUS_M; ring += RING_STEP_M) {
    const directions = ring === 0 ? 1 : DIRECTIONS;
    for (let i = 0; i < directions; i++) {
      const angle = (i / DIRECTIONS) * Math.PI * 2;
      const spot = spotAt(near.x + Math.cos(angle) * ring, near.z + Math.sin(angle) * ring);
      if (spot) return spot;
    }
  }
  return null;
}

/**
 * The street height of the scene: the most common height (to 0.5 m) of the first walkable surface
 * met from above on a 4 m grid over the collider. Roofs come in many heights, streets in one.
 */
export function streetLevel(collider: THREE.Mesh): number {
  const bvh = bvhOf(collider);
  const bounds = boundsOf(collider);
  const top = bounds.max.y + 5;
  const counts = new Map<number, { count: number; sum: number }>();
  for (let x = bounds.min.x + 2; x < bounds.max.x; x += 4) {
    for (let z = bounds.min.z + 2; z < bounds.max.z; z += 4) {
      footprintOrigin.set(x, top, z);
      const hit = castDown(bvh, footprintOrigin, top - bounds.min.y + 1);
      if (!hit?.face || hit.face.normal.y < WALKABLE_NORMAL_Y) continue;
      const key = Math.round(hit.point.y * 2);
      const bin = counts.get(key) ?? { count: 0, sum: 0 };
      bin.count++;
      bin.sum += hit.point.y;
      counts.set(key, bin);
    }
  }
  let best: { count: number; sum: number } | null = null;
  for (const bin of counts.values()) if (!best || bin.count > best.count) best = bin;
  return best ? best.sum / best.count : bounds.min.y;
}
