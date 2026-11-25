import * as THREE from 'three';
import { VOXEL } from '../world/World.js';

const RADIUS = 0.3;
const HEIGHT = 1.8;
const EYE = 1.62;
const STEP = 0.55; // highest ledge walked up automatically (one voxel); 1 m needs a jump
const SNAP = 0.35; // how far we stick to the ground when walking down slopes
const WALKABLE = 0.5; // contact normal y above this counts as floor (60°): 45° slopes built from 0.5 m voxels are a little uneven
const MAX_SUBSTEP = 0.1; // metres per collision substep
const GRAVITY = 28;
const JUMP_V = 8.6;
const WALK = 4.6;
const SPRINT = 7.2;
const FLY = 13;
/** Deeper water than this (metres, above the feet) and you swim rather than wade. */
const SWIM_DEPTH = 1.1;
const SWIM = 3.2;

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _tri = new THREE.Vector3();
const _cap = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Ray();
const _raycaster = new THREE.Raycaster();

/**
 * First-person player: walk with gravity, step-up and ground snapping, or fly.
 *
 * Collision is a capsule against the rendered chunk meshes (terrain and
 * blocks alike) via their BVHs, so you stand exactly on the surface you see,
 * slide smoothly along walls and slopes, and never catch on hidden voxel
 * edges. Walkable slopes push you straight up (no sliding while standing).
 * Everything here is in metres; voxels are VOXEL metres on a side.
 */
export class Player {
  constructor(world, camera, getColliders) {
    this.world = world;
    this.camera = camera;
    this.getColliders = getColliders;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.flying = false;
    this.onGround = false;
    this.camY = 0;
    // Water: whether the eye is under, whether the body's in it, and the
    // last surface level found (metres; -Infinity if dry). onSplash(pos, speed)
    // fires when you fall in.
    this.underwater = false;
    this.inWater = false;
    this.wasInWater = false;
    this.waterLevel = -Infinity;
    this.againstWall = false;
    this.onSplash = null;
    /** (x, y, z voxel, out) => water velocity [x, z] in m/s, if the simulation knows it (else guessed from the slope). */
    this.currentAt = null;
  }

  spawn(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.camY = y;
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0022));
  }

  toggleFly() {
    this.flying = !this.flying;
    this.vel.y = 0;
    return this.flying;
  }

  /** Does the player's box (optionally padded, metres) overlap voxel (x, y, z)? */
  intersectsVoxel(x, y, z, pad = 0) {
    const p = this.pos;
    const V = VOXEL;
    const hw = RADIUS + pad;
    return (
      (x + 1) * V > p.x - hw && x * V < p.x + hw &&
      (z + 1) * V > p.z - hw && z * V < p.z + hw &&
      (y + 1) * V > p.y - pad && y * V < p.y + HEIGHT + pad
    );
  }

  // ------------------------------------------------------------ collision

  /**
   * Push the capsule out of all geometry. Returns contact info:
   * { hit, ground, ceiling, wallNormals[] }.
   */
  resolve() {
    const contact = { hit: false, ground: false, ceiling: false, walls: [] };
    const colliders = this.getColliders();
    _seg.start.set(this.pos.x, this.pos.y + RADIUS, this.pos.z);
    _seg.end.set(this.pos.x, this.pos.y + HEIGHT - RADIUS, this.pos.z);

    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      _box.makeEmpty();
      _box.expandByPoint(_seg.start);
      _box.expandByPoint(_seg.end);
      _box.expandByScalar(RADIUS);

      for (const mesh of colliders) {
        const g = mesh.geometry;
        if (!g.boundsTree || !g.boundingBox.intersectsBox(_box)) continue;
        g.boundsTree.shapecast({
          intersectsBounds: (b) => b.intersectsBox(_box),
          intersectsTriangle: (tri) => {
            const d = tri.closestPointToSegment(_seg, _tri, _cap);
            if (d >= RADIUS) return false;
            if (d > 1e-6) _dir.subVectors(_cap, _tri).divideScalar(d);
            else tri.getNormal(_dir); // segment pierces the triangle: leave along its outward normal
            const depth = RADIUS - d;
            if (_dir.y > WALKABLE) {
              // Floor: lift straight up so standing on a slope doesn't slide.
              const up = depth / _dir.y;
              _seg.start.y += up; _seg.end.y += up;
              contact.ground = true;
            } else {
              _seg.start.addScaledVector(_dir, depth);
              _seg.end.addScaledVector(_dir, depth);
              if (_dir.y < -WALKABLE) contact.ceiling = true;
              else contact.walls.push(_dir.clone());
            }
            pushed = contact.hit = true;
            return false;
          },
        });
      }
      if (!pushed) break;
    }
    this.pos.set(_seg.start.x, _seg.start.y - RADIUS, _seg.start.z);
    return contact;
  }

  /** Is the capsule overlapping any geometry right now? (Doesn't move it.) */
  overlaps() {
    const saved = this.pos.clone();
    const c = this.resolve();
    const moved = this.pos.distanceToSquared(saved) > 1e-8;
    this.pos.copy(saved);
    return c.hit && moved;
  }

  /**
   * Height of a walkable surface just in front of the capsule (direction ux, uz),
   * if it's a step up of at most STEP from `from`; otherwise null.
   */
  ledgeHeight(from, ux, uz) {
    const ahead = RADIUS + 0.12;
    _ray.origin.set(from.x + ux * ahead, from.y + STEP + 0.05, from.z + uz * ahead);
    _ray.direction.set(0, -1, 0);
    _raycaster.ray.copy(_ray);
    _raycaster.far = STEP + 0.05;
    _raycaster.firstHitOnly = true;
    const hit = _raycaster.intersectObjects(this.getColliders(), false)[0];
    if (!hit || !hit.face || hit.face.normal.y < WALKABLE) return null;
    return hit.point.y > from.y + 0.05 ? hit.point.y : null;
  }

  /**
   * If walkable ground is within SNAP below the feet, move down onto it.
   * Uses a ray rather than sinking the capsule, which would overlap deeply
   * and get pushed out in odd directions.
   */
  snapDown() {
    _raycaster.ray.origin.set(this.pos.x, this.pos.y + 0.5, this.pos.z);
    _raycaster.ray.direction.set(0, -1, 0);
    _raycaster.far = 0.5 + SNAP;
    _raycaster.firstHitOnly = true;
    const hit = _raycaster.intersectObjects(this.getColliders(), false)[0];
    if (!hit || !hit.face || hit.face.normal.y < WALKABLE) return false;
    const before = this.pos.clone();
    this.pos.y = Math.min(this.pos.y, hit.point.y);
    const c = this.resolve();
    if (c.ground && Math.hypot(this.pos.x - before.x, this.pos.z - before.z) < 0.02) return true;
    this.pos.copy(before);
    return false;
  }

  /**
   * The water around the player: `depth` (metres of water above the feet; 0
   * if dry) and `flow` (the current, m/s along x and z, from how the surface
   * slopes: water runs downhill). Sets `underwater` (the eye is under).
   */
  sampleWater() {
    const w = this.world, V = VOXEL, p = this.pos;
    const vx = Math.floor(p.x / V), vz = Math.floor(p.z / V);
    let S = -Infinity, sy = 0;
    for (let y = Math.floor((p.y + 0.05) / V); y <= Math.floor((p.y + HEIGHT) / V) && S === -Infinity; y++) {
      S = w.waterSurface(vx, y, vz);
      sy = y;
    }
    const eye = p.y + EYE;
    const se = w.waterSurface(vx, Math.floor(eye / V), vz);
    this.underwater = se > eye;
    this.waterLevel = S;
    if (S === -Infinity) return { depth: 0, flow: [0, 0] };
    // The water's own velocity, where the simulation has one (FluxSim).
    if (this.currentAt) {
      const v = this.currentAt(vx, Math.floor((p.y + 0.3) / V), vz, [0, 0]);
      return { depth: Math.max(0, S - p.y), flow: [v[0] * 0.6, v[1] * 0.6] };
    }
    // Surface slope from the columns either side, at the same layer.
    const at = (x, z) => {
      const s = w.waterSurface(x, sy, z);
      return s === -Infinity ? S : s;
    };
    const gx = (at(vx + 1, vz) - at(vx - 1, vz)) / (2 * V), gz = (at(vx, vz + 1) - at(vx, vz - 1)) / (2 * V);
    const k = 60, max = 2.5;
    const fx = Math.max(-max, Math.min(max, -gx * k)), fz = Math.max(-max, Math.min(max, -gz * k));
    return { depth: Math.max(0, S - p.y), flow: [fx, fz] };
  }

  /** Solidity (0..1) at a point in metres: the trilinear field. */
  fieldAt(x, y, z) {
    const w = this.world;
    const fx = x / VOXEL - 0.5, fy = y / VOXEL - 0.5, fz = z / VOXEL - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
      const vx = x0 + dx, vy = y0 + dy, vz = z0 + dz;
      const o = w.getOcc(vx, vy, vz);
      sum += o * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
    }
    return sum / 255;
  }

  /**
   * Safety net: if the body ends up inside solid ground (e.g. the world changed
   * around us), lift the player out to the first open space above, Minecraft-style.
   */
  unstuck() {
    const p = this.pos;
    const inside = () => this.fieldAt(p.x, p.y + 0.9, p.z) > 0.6 || this.fieldAt(p.x, p.y + 0.35, p.z) > 0.75;
    if (!inside()) return;
    for (let i = 0; i < 400 && inside(); i++) p.y += 0.1;
    this.resolve();
    this.vel.set(0, 0, 0);
    this.camY = p.y;
  }

  /** Move by (dx, dy, dz) and resolve; handles step-up onto ledges. */
  move(dx, dy, dz, canStep) {
    const start = this.pos.clone();
    this.pos.x += dx; this.pos.y += dy; this.pos.z += dz;
    let c = this.resolve();

    const want = Math.hypot(dx, dz);
    if (canStep && want > 1e-5) {
      const got = Math.hypot(this.pos.x - start.x, this.pos.z - start.z);
      if (got < want * 0.5) {
        // Blocked: look for a walkable ledge just ahead, no higher than STEP.
        const h = this.ledgeHeight(start, dx / want, dz / want);
        if (h !== null) {
          const blocked = this.pos.clone();
          this.pos.set(start.x + dx, h + 0.01, start.z + dz);
          if (!this.overlaps()) {
            // Up on the ledge; the next substeps carry us onto its top.
            return { hit: true, ground: true, ceiling: false, walls: [] };
          }
          this.pos.copy(blocked);
        }
      }
    }
    return c;
  }

  // ------------------------------------------------------------- update

  update(dt, keys) {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * fwd + cos * strafe;
    let wz = -cos * fwd - sin * strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    const v = this.vel;
    const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const water = this.sampleWater();
    if (this.flying) {
      const up = (keys.has('Space') ? 1 : 0) - (shift ? 1 : 0);
      const k = Math.min(1, dt * 10);
      v.x += (wx * FLY - v.x) * k;
      v.z += (wz * FLY - v.z) * k;
      v.y += (up * FLY - v.y) * k;
    } else if (water.depth > SWIM_DEPTH) {
      // Swimming: buoyancy all but cancels gravity, water drags, Space swims
      // up, and with the head under you swim the way you look.
      const under = this.underwater;
      const k = Math.min(1, dt * 3);
      const pitchUp = under && fwd ? Math.sin(this.pitch) * fwd : 0;
      const across = under && fwd ? Math.cos(this.pitch) : 1;
      v.x += (wx * SWIM * across - v.x) * k;
      v.z += (wz * SWIM * across - v.z) * k;
      let up = (keys.has('Space') ? 1 : 0) + pitchUp - (shift ? 1 : 0);
      // Left alone you float up, to rest with the head just out.
      if (!up && water.depth > SWIM_DEPTH + 0.25) up = under ? 0.5 : 0.4;
      v.y += (up * SWIM - v.y) * Math.min(1, dt * 2.5) - GRAVITY * 0.04 * dt;
      // Climbing out: Space against a bank at the surface.
      if (keys.has('Space') && this.againstWall && water.depth < 1.4) v.y = JUMP_V * 0.75;
    } else {
      // Wading slows you, the deeper the more.
      const wade = 1 - 0.55 * Math.min(1, water.depth / SWIM_DEPTH);
      const speed = (shift ? SPRINT : WALK) * wade;
      const k = Math.min(1, dt * (this.onGround ? 14 : 3));
      v.x += (wx * speed - v.x) * k;
      v.z += (wz * speed - v.z) * k;
      v.y = Math.max(water.depth > 0 ? -12 : -50, v.y - GRAVITY * dt);
      if (keys.has('Space') && this.onGround) { v.y = JUMP_V * (1 - 0.35 * Math.min(1, water.depth / SWIM_DEPTH)); this.onGround = false; }
    }
    // The current carries you along.
    if (!this.flying && water.depth > 0.05) {
      const pull = Math.min(1, water.depth / 0.6) * dt * 4;
      v.x += water.flow[0] * pull;
      v.z += water.flow[1] * pull;
    }
    this.wasInWater = this.inWater;
    this.inWater = water.depth > 0.05;
    if (this.inWater && !this.wasInWater && v.y < -4) this.onSplash?.(this.pos.clone(), -v.y);

    if (dt > 0) {
      const dist = Math.hypot(v.x, v.y, v.z) * dt;
      const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP));
      const h = dt / steps;
      this.againstWall = false;
      for (let s = 0; s < steps; s++) {
        const wasGround = this.onGround;
        const c = this.move(v.x * h, v.y * h, v.z * h, !this.flying && wasGround);
        this.onGround = c.ground;
        if (c.walls.length) this.againstWall = true;
        if (c.ground && v.y < 0) {
          v.y = 0;
          if (this.flying) this.flying = false; // landing ends flight, as in Minecraft
        }
        if (c.ceiling && v.y > 0) v.y = 0;
        for (const n of c.walls) {
          const into = v.x * n.x + v.y * n.y + v.z * n.z;
          if (into < 0) { v.x -= n.x * into; v.y -= n.y * into; v.z -= n.z * into; }
        }
        // Stick to the ground walking down slopes and off small ledges.
        if (wasGround && !this.onGround && !this.flying && v.y <= 0) this.onGround = this.snapDown();
      }
    }

    this.unstuck();

    // Stay inside the world's horizontal bounds; respawn if we fall out.
    const w = this.world;
    this.pos.x = Math.min(w.sx * VOXEL - RADIUS, Math.max(RADIUS, this.pos.x));
    this.pos.z = Math.min(w.sz * VOXEL - RADIUS, Math.max(RADIUS, this.pos.z));
    if (this.pos.y < -20) this.onFallOut?.();

    // Smooth the camera over step-ups so it doesn't snap.
    if (this.pos.y > this.camY) this.camY += (this.pos.y - this.camY) * Math.min(1, dt * 16);
    else this.camY = this.pos.y;
    this.camera.position.set(this.pos.x, this.camY + EYE, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
