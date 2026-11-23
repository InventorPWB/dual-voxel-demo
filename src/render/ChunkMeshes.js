import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CRISP } from '../world/materials.js';
import { VOXEL } from '../world/World.js';
import { SHADOW_LAYER } from './SunShadow.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Keeps the three.js meshes of each chunk in sync with the voxel data. Dirty
 * chunks are re-meshed on a pool of web workers, nearest to the player first.
 * Per chunk:
 *  - a solid mesh (terrain, pieces, glass) with one group per render pass and
 *    a BVH: it's what the player collides with and aims at (`list`);
 *  - a foliage mesh (grass, flowers, leaves): drawn only, never collided with.
 *
 * @param solid    { materials, shadowMaterials } for the solid mesh's passes
 * @param foliage  { materials, shadowMaterials } for the foliage groups
 */
export class ChunkMeshes {
  constructor(world, scene, solid, foliage) {
    this.world = world;
    this.scene = scene;
    this.solid = solid;
    this.foliageMaterials = foliage;
    this.meshes = new Array(world.chunks.length).fill(null);
    this.foliage = new Array(world.chunks.length).fill(null);
    this.foliageList = [];
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

  get pending() {
    return this.world.dirty.size + this.inFlight.filter(Boolean).length;
  }

  /** Dispatch dirty chunks to idle workers, closest to `focus` (metres) first. */
  update(focus) {
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
        continue;
      }
      const worker = this.idle.pop();
      this.inFlight[index] = true;
      this.version[index]++;
      worker.postMessage(
        { type: 'mesh', index, version: this.version[index], ...padded },
        [padded.mat.buffer, padded.shape.buffer, padded.off.buffer, padded.cut.buffer, padded.et.buffer, padded.en.buffer, ...(padded.plant ? [padded.plant.buffer] : [])],
      );
    }
  }

  onResult(worker, msg) {
    this.idle.push(worker);
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
      g.setAttribute('ao', new THREE.BufferAttribute(solid.ao, 1));
      g.setAttribute('local', new THREE.BufferAttribute(solid.local, 4));
      for (const grp of solid.groups) g.addGroup(grp.start, grp.count, grp.pass);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      g.computeBoundsTree();
      this.setGeometry(msg.index, g);
    }
    if (foliage.triangles === 0) this.setFoliage(msg.index, null);
    else {
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
      this.setFoliage(msg.index, g);
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
