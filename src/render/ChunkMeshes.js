import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CRISP } from '../world/materials.js';
import { VOXEL } from '../world/World.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Keeps one three.js mesh per chunk in sync with the voxel data. Dirty chunks
 * are re-meshed on a pool of web workers, nearest to the player first.
 */
export class ChunkMeshes {
  constructor(world, scene, material) {
    this.world = world;
    this.scene = scene;
    this.material = material;
    this.meshes = new Array(world.chunks.length).fill(null);
    this.inFlight = new Array(world.chunks.length).fill(false);
    this.version = new Array(world.chunks.length).fill(0);
    this.list = []; // live meshes, for raycasting
    this.lastMeshMs = 0;

    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.idle = [];
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../mesh/meshWorker.js', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', crisp: CRISP, scale: VOXEL });
      worker.onmessage = (e) => this.onResult(worker, e.data);
      this.idle.push(worker);
    }
    this.workerCount = count;
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
        continue;
      }
      const worker = this.idle.pop();
      this.inFlight[index] = true;
      this.version[index]++;
      worker.postMessage(
        { type: 'mesh', index, version: this.version[index], ...padded },
        [padded.mat.buffer, padded.shape.buffer, padded.et.buffer, padded.en.buffer],
      );
    }
  }

  onResult(worker, msg) {
    this.idle.push(worker);
    this.inFlight[msg.index] = false;
    this.lastMeshMs = msg.ms;
    if (msg.triangles === 0) {
      this.setGeometry(msg.index, null);
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(msg.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(msg.normal, 3));
    g.setAttribute('material', new THREE.BufferAttribute(msg.material, 1));
    g.setAttribute('ao', new THREE.BufferAttribute(msg.ao, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.computeBoundsTree();
    this.setGeometry(msg.index, g);
  }

  setGeometry(index, geometry) {
    let mesh = this.meshes[index];
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
      mesh = new THREE.Mesh(geometry, this.material);
      mesh.matrixAutoUpdate = false;
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
}

function dist2([cx, cy, cz], focus, s) {
  const dx = (cx + 0.5) * s - focus.x, dy = (cy + 0.5) * s - focus.y, dz = (cz + 0.5) * s - focus.z;
  return dx * dx + dy * dy + dz * dz;
}
