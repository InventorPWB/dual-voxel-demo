import * as THREE from 'three';
import { World, VOXEL } from '../world/World.js';
import { remove } from '../world/chop.js';
import { SHADOW_LAYER } from './SunShadow.js';

const SIZE = 32; // chunk size of the scratch world a falling piece is meshed in
const REST = 1.2; // seconds it lies before sinking away
const SINK = 1.4; // seconds to sink out of sight
const SINK_DEPTH = 4; // metres

/**
 * What an axe cuts free falls. The severed wood and leaves (see chop.js) are
 * copied into a scratch world of their own and meshed there on the chunk
 * workers, exactly as they looked; only then do they leave the world, and the
 * copy topples over away from the cut about where it was cut through,
 * gathering speed like a real tree, lies there a moment, and sinks away.
 */
export class Felling {
  constructor({ world, scene, chunkMeshes, shadow }) {
    this.world = world;
    this.scene = scene;
    this.chunkMeshes = chunkMeshes;
    this.shadow = shadow;
    this.falling = [];
  }

  /** Meshes falling right now (for the sun's shadow pass). */
  get meshes() {
    return this.falling.flatMap((f) => f.meshes);
  }

  /**
   * Let severed set `set` fall: cut through at voxel `cell`, toppling
   * towards horizontal direction `away`.
   */
  async fell(set, cell, away) {
    if (!set.box) return;
    const [x0, y0, z0, x1, y1, z1] = set.box;
    const o = [x0 - 3, y0 - 3, z0 - 3];
    const n = [x1 - x0, y1 - y0, z1 - z0].map((d) => Math.ceil((d + 7) / SIZE));
    const scratch = new World(n[0], n[1], n[2], SIZE);
    for (const [x, y, z, id] of set.wood) scratch.setPlant(x - o[0], y - o[1], z - o[2], id);
    for (const [x, y, z] of set.leaves) scratch.setPlant(x - o[0], y - o[1], z - o[2], this.world.getPlant(x, y, z));
    const jobs = [];
    for (let cz = 0; cz < n[2]; cz++)
      for (let cy = 0; cy < n[1]; cy++)
        for (let cx = 0; cx < n[0]; cx++) {
          const padded = scratch.buildPadded(cx, cy, cz);
          if (!padded.uniform) jobs.push(this.chunkMeshes.meshDetached(padded));
        }
    const geometries = (await Promise.all(jobs)).filter(Boolean);
    remove(this.world, set);

    // Turning about the cut, on the axis square to the way it falls.
    const pivot = new THREE.Group();
    pivot.position.set((cell[0] + 0.5) * VOXEL, (cell[1] + 0.5) * VOXEL, (cell[2] + 0.5) * VOXEL);
    const inner = new THREE.Group();
    inner.position.set(o[0] * VOXEL - pivot.position.x, o[1] * VOXEL - pivot.position.y, o[2] * VOXEL - pivot.position.z);
    pivot.add(inner);
    const { materials, shadowMaterials } = this.chunkMeshes.foliageMaterials;
    const meshes = geometries.map((g) => {
      const m = new THREE.Mesh(g, materials);
      m.layers.enable(SHADOW_LAYER);
      m.userData.shadowMaterial = shadowMaterials;
      inner.add(m);
      return m;
    });
    this.scene.add(pivot);
    const axis = new THREE.Vector3(away[2], 0, -away[0]).normalize();
    // It comes to rest most of the way over (a crown props it up a little
    // off the ground); a short piece stops sooner.
    const height = (y1 - cell[1]) * VOXEL;
    this.falling.push({ pivot, meshes, axis, angle: 0.06, speed: 0.15, stop: height > 2 ? 1.45 : 1.25, height, t: 0 });
    this.shadow.dirty = true;
  }

  update(dt) {
    if (!this.falling.length) return;
    for (const f of this.falling) {
      if (f.angle < f.stop) {
        // A toppling stick: angular acceleration grows as it leans over.
        f.speed += (18 / Math.max(2, f.height)) * Math.sin(f.angle) * dt;
        f.angle = Math.min(f.stop, f.angle + f.speed * dt);
      } else {
        f.t += dt;
        if (f.t > REST) f.pivot.position.y -= (SINK_DEPTH / SINK) * dt;
      }
      f.pivot.quaternion.setFromAxisAngle(f.axis, f.angle);
    }
    for (const f of this.falling.filter((f) => f.t > REST + SINK)) {
      this.scene.remove(f.pivot);
      for (const m of f.meshes) m.geometry.dispose();
    }
    this.falling = this.falling.filter((f) => f.t <= REST + SINK);
    this.shadow.dirty = true;
  }
}
