import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CRISP } from '../world/materials.js';
import { VOXEL } from '../world/World.js';
import { SHADOW_LAYER } from './SunShadow.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const COLLIDER_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** Most times a second one chunk's water is re-meshed. */
const WATER_HZ = 10;

/**
 * Water's own layer: the camera sees it (main.js enables it), the sun's
 * shadow camera doesn't, and PostFX can draw it in a pass of its own.
 */
export const WATER_LAYER = 2;

/**
 * Keeps the three.js meshes of each chunk in sync with the voxel data. Dirty
 * chunks are re-meshed on a pool of web workers, nearest to the player first.
 * Per chunk:
 *  - a solid mesh (terrain, pieces, glass) with one group per render pass and
 *    a BVH: it's what the player collides with and aims at (`list`);
 *  - a foliage mesh (grass, flowers, leaves, wood): drawn only;
 *  - a wood collider: the triangles of wood thick enough to be solid, with
 *    a BVH, not drawn: collided with and aimed at like the solid mesh
 *    (`colliders`); `userData.cells` gives each triangle's voxel.
 *
 * @param solid    { materials, shadowMaterials } for the solid mesh's passes
 * @param foliage  { materials, shadowMaterials } for the foliage groups
 */
export class ChunkMeshes {
  constructor(world, scene, solid, foliage, water = null) {
    this.world = world;
    this.scene = scene;
    this.solid = solid;
    this.foliageMaterials = foliage;
    this.waterMaterial = water;
    /** Mesh water as the contoured surface (fluidSurface.js, for FluxSim) rather than the cellular one's mesher. */
    this.waterSurface = false;
    /** SpanSim, when that's the water: meshed from its spans (spanMesh.js) instead of the voxels. */
    this.spanSim = null;
    // Water: its own meshes, re-meshed separately (and at most WATER_HZ per chunk) as it moves.
    this.water = new Array(world.chunks.length).fill(null);
    this.waterList = [];
    this.waterInFlight = new Array(world.chunks.length).fill(false);
    this.waterVersion = new Array(world.chunks.length).fill(0);
    this.waterSent = new Float64Array(world.chunks.length).fill(-1e9);
    this.meshes = new Array(world.chunks.length).fill(null);
    this.foliage = new Array(world.chunks.length).fill(null);
    this.foliageList = [];
    this.wood = new Array(world.chunks.length).fill(null);
    this.woodList = [];
    this.inFlight = new Array(world.chunks.length).fill(false);
    this.version = new Array(world.chunks.length).fill(0);
    this.list = []; // live meshes, for raycasting
    this.onChange = null; // called whenever a chunk's mesh is replaced or removed
    this.lastMeshMs = 0;

    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.idle = [];
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../mesh/meshWorker.js', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', crisp: CRISP, scale: VOXEL });
      worker.onmessage = (e) => this.onResult(worker, e.data);
      this.idle.push(worker);
      this.workers.push(worker);
    }
    this.workerCount = count;
  }

  /** Change how foliage is meshed (see meshFoliage's options); re-mesh everything unless `remesh` is false. */
  setFoliageOptions(options, remesh = true) {
    for (const w of this.workers) w.postMessage({ type: 'options', foliage: options });
    if (remesh) this.world.markAllDirty();
  }

  /** Everything solid: the solid meshes and the wood colliders. */
  get colliders() {
    return this.woodList.length ? this.list.concat(this.woodList) : this.list;
  }

  get pending() {
    return this.world.dirty.size + this.inFlight.filter(Boolean).length;
  }

  /** Dispatch dirty chunks to idle workers, closest to `focus` (metres) first: ground, then water. */
  update(focus) {
    this.updateSolid(focus);
    this.updateWater(focus);
  }

  updateWater(focus) {
    const { world } = this;
    if (!this.waterMaterial || !world.fluidDirty.size || !this.idle.length) return;
    const now = performance.now();
    const s = world.size * VOXEL;
    // Running water keeps chunks dirty: farther ones are re-meshed less
    // often, and the longer one has waited the sooner it goes, so near
    // water can't starve the rest.
    const d2 = (i) => dist2(world.chunkCoords(i), focus, s);
    const order = [...world.fluidDirty].filter((i) => !this.waterInFlight[i] && now - this.waterSent[i] >= (1000 / WATER_HZ) * (1 + Math.sqrt(d2(i)) / 24));
    const rank = (i) => d2(i) / (1 + Math.min(10, (now - this.waterSent[i]) / 1000)) ** 2;
    order.sort((a, b) => rank(a) - rank(b));
    for (const index of order) {
      if (!this.idle.length) break;
      world.fluidDirty.delete(index);
      const [cx, cy, cz] = world.chunkCoords(index);
      if (this.spanSim) {
        const snap = this.spanSim.snapshot(cx, cy, cz);
        this.waterVersion[index]++;
        if (!snap) {
          this.setWater(index, null);
          continue;
        }
        const worker = this.idle.pop();
        this.waterInFlight[index] = true;
        this.waterSent[index] = now;
        worker.postMessage({ type: 'spans', index, version: this.waterVersion[index], ...snap }, [snap.start.buffer, snap.rec.buffer, snap.falls.buffer, snap.glass.buffer]);
        continue;
      }
      const padded = world.buildFluidPadded(cx, cy, cz, this.waterSurface);
      this.waterVersion[index]++;
      if (!padded) {
        this.setWater(index, null);
        continue;
      }
      const worker = this.idle.pop();
      this.waterInFlight[index] = true;
      this.waterSent[index] = now;
      worker.postMessage(
        { type: 'fluid', index, version: this.waterVersion[index], surface: this.waterSurface, ...padded },
        [padded.mat.buffer, padded.shape.buffer, padded.fluid.buffer, padded.floor.buffer, ...(padded.et ? [padded.et.buffer, padded.en.buffer, padded.flux.buffer] : [])],
      );
    }
  }

  onWater(msg) {
    this.waterInFlight[msg.index] = false;
    if (msg.version !== this.waterVersion[msg.index]) return;
    const { water } = msg;
    if (!water.triangles) {
      this.setWater(msg.index, null);
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(water.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(water.normal, 3));
    g.setAttribute('flow', new THREE.BufferAttribute(water.flow, 3));
    g.setAttribute('depth', new THREE.BufferAttribute(water.depth, 1));
    if (this.spanSim) g.setAttribute('morph', new THREE.BufferAttribute(this.morphFrom(msg.index, water.position), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.setWater(msg.index, g);
  }

  /**
   * For a chunk's new water mesh: where each vertex was in the mesh it
   * replaces (the height shown there now, mid-glide or not), when, and over
   * how long to glide from there (about the time between the two meshes), so
   * the surface moves smoothly rather than jumping at each re-mesh. A vertex
   * with no counterpart (new water, or a level that's changed past JOIN)
   * starts where it is.
   */
  morphFrom(index, position) {
    const now = performance.now() / 1000;
    const count = position.length / 3;
    const morph = new Float32Array(count * 3);
    const old = this.water[index]?.geometry;
    const was = old?.attributes.morph ? old : null;
    const dur = was ? Math.min(0.6, Math.max(0.05, now - was.userData.arrived)) : 0;
    // Heights shown now by the old mesh, per (x, z) corner.
    const at = new Map();
    if (was) {
      const p = was.attributes.position.array, m = was.attributes.morph.array;
      for (let v = 0; v < p.length / 3; v++) {
        const t = m[v * 3 + 2] > 0 ? Math.min(1, Math.max(0, (now - m[v * 3 + 1]) / m[v * 3 + 2])) : 1;
        const y = m[v * 3] + (p[v * 3 + 1] - m[v * 3]) * t;
        const key = `${p[v * 3].toFixed(3)},${p[v * 3 + 2].toFixed(3)}`;
        const list = at.get(key);
        if (list) list.push(p[v * 3 + 1], y);
        else at.set(key, [p[v * 3 + 1], y]);
      }
    }
    const reach = 0.5; // metres: past this it's a different sheet
    for (let v = 0; v < count; v++) {
      const y = position[v * 3 + 1];
      let from = y;
      const list = at.get(`${position[v * 3].toFixed(3)},${position[v * 3 + 2].toFixed(3)}`);
      if (list) {
        let best = reach;
        for (let n = 0; n < list.length; n += 2) {
          const e = Math.abs(list[n] - y);
          if (e < best) { best = e; from = list[n + 1]; }
        }
      }
      morph[v * 3] = from;
      morph[v * 3 + 1] = now;
      morph[v * 3 + 2] = dur;
    }
    return morph;
  }

  /** Water mesh of a chunk: drawn only (not collided with or aimed at). */
  setWater(index, geometry) {
    let mesh = this.water[index];
    if (mesh) mesh.geometry.dispose();
    if (!geometry) {
      if (mesh) {
        this.scene.remove(mesh);
        this.water[index] = null;
        this.waterList = this.water.filter(Boolean);
      }
      return;
    }
    geometry.userData.arrived = performance.now() / 1000;
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, this.waterMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1; // after the ground and glass
      mesh.layers.set(WATER_LAYER);
      this.water[index] = mesh;
      this.scene.add(mesh);
      this.waterList = this.water.filter(Boolean);
    } else {
      mesh.geometry = geometry;
    }
  }

  waterTriangleCount() {
    let t = 0;
    for (const m of this.waterList) t += m.geometry.attributes.position.count / 3;
    return t;
  }

  updateSolid(focus) {
    const { world } = this;
    if (!world.dirty.size || !this.idle.length) return;
    const s = world.size * VOXEL;
    const order = [...world.dirty].filter((i) => !this.inFlight[i]);
    order.sort((a, b) => dist2(world.chunkCoords(a), focus, s) - dist2(world.chunkCoords(b), focus, s));
    for (const index of order) {
      if (!this.idle.length) break;
      world.dirty.delete(index);
      const [cx, cy, cz] = world.chunkCoords(index);
      const padded = world.buildPadded(cx, cy, cz);
      if (padded.uniform) {
        this.setGeometry(index, null);
        this.setFoliage(index, null);
        this.setWood(index, null);
        continue;
      }
      const worker = this.idle.pop();
      this.inFlight[index] = true;
      this.version[index]++;
      worker.postMessage(
        { type: 'mesh', index, version: this.version[index], ...padded },
        [padded.mat.buffer, padded.shape.buffer, padded.off.buffer, padded.et.buffer, padded.en.buffer, ...(padded.plant ? [padded.plant.buffer] : [])],
      );
    }
  }

  onResult(worker, msg) {
    this.idle.push(worker);
    if (msg.type === 'fluid') {
      this.onWater(msg);
      return;
    }
    this.inFlight[msg.index] = false;
    this.lastMeshMs = msg.ms;
    // A newer request for this chunk is on its way: this result is stale.
    if (msg.version !== this.version[msg.index]) return;
    const { solid, foliage } = msg;
    if (solid.triangles === 0) this.setGeometry(msg.index, null);
    else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(solid.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(solid.normal, 3));
      g.setAttribute('material', new THREE.BufferAttribute(solid.material, 1));
      g.setAttribute('blend', new THREE.BufferAttribute(solid.blend, 1));
      g.setAttribute('ao', new THREE.BufferAttribute(solid.ao, 1));
      g.setAttribute('local', new THREE.BufferAttribute(solid.local, 4));
      for (const grp of solid.groups) g.addGroup(grp.start, grp.count, grp.pass);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      g.computeBoundsTree();
      this.setGeometry(msg.index, g);
    }
    this.setFoliage(msg.index, foliage.triangles === 0 ? null : foliageGeometry(foliage));
    if (foliage.wood.triangles === 0) this.setWood(msg.index, null);
    else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(foliage.wood.position, 3));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      g.computeBoundsTree();
      this.setWood(msg.index, g, foliage.wood.cell);
    }
  }

  /** Wood collider of a chunk (never added to the scene). */
  setWood(index, geometry, cells = null) {
    const old = this.wood[index];
    if (old) {
      old.geometry.disposeBoundsTree();
      old.geometry.dispose();
    }
    if (!geometry) {
      if (old) {
        this.wood[index] = null;
        this.woodList = this.wood.filter(Boolean);
      }
      return;
    }
    // (Both sides count, so aim never slips in through an open end.)
    const mesh = old || new THREE.Mesh(geometry, COLLIDER_MATERIAL);
    mesh.geometry = geometry;
    mesh.userData.cells = cells;
    mesh.updateMatrixWorld();
    if (!old) {
      this.wood[index] = mesh;
      this.woodList = this.wood.filter(Boolean);
    }
  }

  setFoliage(index, geometry) {
    let mesh = this.foliage[index];
    if (mesh || geometry) this.onChange?.(index);
    if (mesh) mesh.geometry.dispose();
    if (!geometry) {
      if (mesh) {
        this.scene.remove(mesh);
        this.foliage[index] = null;
        this.foliageList = this.foliage.filter(Boolean);
      }
      return;
    }
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, this.foliageMaterials.materials);
      mesh.matrixAutoUpdate = false;
      mesh.layers.enable(SHADOW_LAYER);
      mesh.userData.shadowMaterial = this.foliageMaterials.shadowMaterials;
      this.foliage[index] = mesh;
      this.scene.add(mesh);
      this.foliageList = this.foliage.filter(Boolean);
    } else {
      mesh.geometry = geometry;
    }
  }

  setGeometry(index, geometry) {
    let mesh = this.meshes[index];
    if (mesh || geometry) this.onChange?.(index);
    if (mesh) {
      mesh.geometry.disposeBoundsTree();
      mesh.geometry.dispose();
    }
    if (!geometry) {
      if (mesh) {
        this.scene.remove(mesh);
        this.meshes[index] = null;
        this.list = this.meshes.filter(Boolean);
      }
      return;
    }
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, this.solid.materials);
      mesh.matrixAutoUpdate = false;
      mesh.layers.enable(SHADOW_LAYER);
      mesh.userData.shadowMaterial = this.solid.shadowMaterials;
      this.meshes[index] = mesh;
      this.scene.add(mesh);
      this.list = this.meshes.filter(Boolean);
    } else {
      mesh.geometry = geometry;
    }
  }

  triangleCount() {
    let t = 0;
    for (const m of this.list) t += m.geometry.attributes.position.count / 3;
    return t;
  }

  foliageTriangleCount() {
    let t = 0;
    for (const m of this.foliageList) t += m.geometry.attributes.position.count / 3;
    return t;
  }
}

function dist2([cx, cy, cz], focus, s) {
  const dx = (cx + 0.5) * s - focus.x, dy = (cy + 0.5) * s - focus.y, dz = (cz + 0.5) * s - focus.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Geometry of a meshFoliage result. */
function foliageGeometry(foliage) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(foliage.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(foliage.normal, 3));
  g.setAttribute('uvl', new THREE.BufferAttribute(foliage.uvl, 3));
  g.setAttribute('wind', new THREE.BufferAttribute(foliage.wind, 1));
  g.setAttribute('ao', new THREE.BufferAttribute(foliage.ao, 1));
  g.setAttribute('seed', new THREE.BufferAttribute(foliage.seed, 1));
  g.setAttribute('center', new THREE.BufferAttribute(foliage.center, 3));
  g.setAttribute('axis', new THREE.BufferAttribute(foliage.axis, 3));
  for (const grp of foliage.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // Sway reaches a little beyond the resting geometry.
  g.boundingSphere.radius += 0.3;
  return g;
}
