import * as THREE from 'three';
import { World, VOXEL } from '../world/World.js';
import { MATERIALS, MAT } from '../world/materials.js';
import { placement, rotationForFacing, CUBE } from '../world/shapes.js';
import {
  sculptSphere, smoothBrush, flattenBrush, placeShape, shapeSolidVoxels, breakCells, clearCells,
} from '../world/edits.js';
import { PLANTS, PLANT, PLANT_KIND, supportsPlant } from '../world/plants.js';
import { meshChunk } from '../mesh/dualContour.js';
import { averageColor } from '../render/textures.js';

const BUILD_REACH = 7; // metres
/** Pieces placed on natural ground snap to this vertical grid (voxels): 1 m. */
const GROUND_LEVEL = 2;
const TOOL_REACH = 24;
const DIG_SPEED = 2; // metres per second the surface moves under a held tool
const BRUSH_HZ = 40;
const REPEAT_DELAY = 0.3;
const REPEAT_RATE = 0.18;

const REMOVE_COLOR = new THREE.Color(0xff5a4a);
const BLOCKED_COLOR = new THREE.Color(0x888888);
const tint = new Map();
const materialColor = (id) => {
  if (!tint.has(id)) tint.set(id, new THREE.Color(...averageColor(MATERIALS[id].top)));
  return tint.get(id);
};
const LEAF_COLOR = new THREE.Color(...averageColor('leaves'));

/**
 * What the held item does in the world. The only things drawn in the world
 * are a ghost of the shape about to be placed (or removed) and, for tools,
 * a ring showing the brush.
 */
export class Interaction {
  constructor({ world, scene, camera, chunkMeshes, player, hotbar }) {
    this.world = world;
    this.camera = camera;
    this.chunkMeshes = chunkMeshes;
    this.player = player;
    this.hotbar = hotbar; // { item } getter for the held item
    this.lmb = false;
    this.rmb = false;
    this.shift = false;
    this.hit = null;
    this.flattenY = null;
    this.brushAccum = 0;
    this.repeat = 0;
    this.lastNatural = MAT.DIRT;
    this.radius = new Map(); // per-tool brush radius (metres)

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    // Ghost of the shape about to be placed/removed: meshed from the shape's own field.
    this.ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghostEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.ghostEdges.renderOrder = 11;
    this.ghostCache = new Map();

    // Tool brush: translucent sphere + ring on the surface (or a disc for the level).
    this.brush = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
    );
    this.ring.renderOrder = 10;
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    );
    for (const g of [this.ghost, this.ghostEdges, this.brush, this.ring, this.disc]) {
      g.visible = false;
      scene.add(g);
    }
  }

  get item() {
    return this.hotbar.item;
  }

  radiusOf(tool) {
    return this.radius.get(tool.id) ?? tool.radius;
  }

  /** Alt + wheel: resize the held tool's brush. Returns the new radius, or null. */
  resize(dir) {
    const item = this.item;
    if (!item || item.kind !== 'tool') return null;
    const r = Math.max(0.5, Math.min(5, this.radiusOf(item) + dir * 0.5));
    this.radius.set(item.id, r);
    return r;
  }

  mouseDown(button) {
    if (button === 0) this.lmb = true;
    if (button === 2) this.rmb = true;
    const item = this.item;
    if (!item) return;
    if (item.kind !== 'tool') {
      this.itemAction(button === 0);
      this.repeat = REPEAT_DELAY;
    } else {
      // Level to whole metres, so a levelled pad lines up with the build grid.
      if (item.id === 'level' && this.hit) this.flattenY = Math.round(this.hit.point.y);
      this.brushAccum = 1 / BRUSH_HZ; // apply right away
    }
  }

  mouseUp(button) {
    if (button === 0) this.lmb = false;
    if (button === 2) this.rmb = false;
    if (!this.lmb && !this.rmb) this.flattenY = null;
  }

  releaseAll() {
    this.lmb = this.rmb = false;
    this.flattenY = null;
  }

  // ---- targeting -----------------------------------------------------------

  /**
   * What the crosshair is on: the nearest solid surface (chunk meshes), or a
   * leaf voxel in front of it ({ leaf: [x, y, z] }, with the voxel face hit).
   * Grass and flowers are looked through.
   */
  raycast(reach) {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    this.raycaster.far = reach;
    const h = this.raycaster.intersectObjects(this.chunkMeshes.list, false)[0];
    const leaf = this.leafRay(this.raycaster.ray, h ? h.distance : reach);
    if (leaf) return leaf;
    if (!h) return null;
    return { point: h.point.clone(), normal: h.face.normal.clone() };
  }

  /** Voxel walk (Amanatides and Woo) along the ray for the first targetable plant within `far` metres. */
  leafRay(ray, far) {
    const o = ray.origin, d = ray.direction;
    const p = [o.x / VOXEL, o.y / VOXEL, o.z / VOXEL], dir = [d.x, d.y, d.z];
    const cell = p.map(Math.floor);
    const step = dir.map((v) => (v > 0 ? 1 : -1));
    const tDelta = dir.map((v) => (v ? Math.abs(1 / v) : Infinity));
    const tMax = dir.map((v, k) => (v ? ((v > 0 ? cell[k] + 1 - p[k] : p[k] - cell[k]) / Math.abs(v)) : Infinity));
    const limit = far / VOXEL;
    let t = 0, axis = -1;
    while (t <= limit) {
      const id = this.world.getPlant(cell[0], cell[1], cell[2]);
      if (id && PLANTS[id].targetable && axis >= 0) {
        const normal = new THREE.Vector3();
        normal.setComponent(axis, -step[axis]);
        const point = new THREE.Vector3(o.x + d.x * t * VOXEL, o.y + d.y * t * VOXEL, o.z + d.z * t * VOXEL);
        return { point, normal, leaf: cell.slice() };
      }
      axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      t = tMax[axis];
      cell[axis] += step[axis];
      tMax[axis] += tDelta[axis];
    }
    return null;
  }

  /**
   * Where the held shape goes, Minecraft-style, always on the world's build
   * grid (1 m for 1 m pieces, 0.5 m steps for slabs and small blocks):
   *  - it goes in the grid cell just beyond the face you aim at;
   *  - if that cell is partly taken by a piece already there (say a block on
   *    top of a half-height slab), it moves one more step out;
   *  - on natural ground it sits at the nearest whole-metre level, so
   *    neighbours share a height. Nothing is filled in underneath.
   * `blocked` is set if it still overlaps a piece.
   */
  shapeTarget(item) {
    const { point, normal: n } = this.hit;
    const w = this.world;
    const p = [point.x / VOXEL, point.y / VOXEL, point.z / VOXEL];
    const an = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const k = an[1] >= an[0] && an[1] >= an[2] ? 1 : an[0] >= an[2] ? 0 : 2;
    const sign = Math.sign([n.x, n.y, n.z][k]) || 1;

    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const rot = item.shape.oriented ? rotationForFacing(dir.x, dir.z) : 0;
    const flip = !!item.shape.oriented && k === 1 && sign < 0;
    const L = item.shape.lattice;

    const behind = this.aimedVoxel();
    const onGround = !this.hit.leaf && !w.isPiece(...behind) && w.isTerrain(...behind) && k === 1 && sign > 0;

    // The grid cell holding a point just outside the face.
    const q = p.slice();
    q[k] += sign * 0.05;
    const origin = q.map((v, j) => Math.floor(v / L[j]) * L[j]);
    if (onGround) origin[1] = Math.round(p[1] / GROUND_LEVEL) * GROUND_LEVEL;
    const overlaps = (t) => t.voxels.some(([x, y, z]) => w.isPiece(x, y, z));
    let target = placement(item.shape, origin, rot, flip);
    if (overlaps(target)) {
      origin[k] += sign * L[k];
      target = placement(item.shape, origin, rot, flip);
    }
    target.blocked = overlaps(target);
    return target;
  }

  /**
   * The solid voxel the crosshair is on, behind the surface you aim at. A
   * piece's face is on its voxel's side, but smooth ground can lie up to a
   * voxel in front of the solid voxel it belongs to (solidity is sampled at
   * voxel centres), so look a little deeper until something solid turns up.
   */
  aimedVoxel() {
    if (this.hit.leaf) return this.hit.leaf;
    const { point, normal: n } = this.hit;
    const p = [point.x / VOXEL, point.y / VOXEL, point.z / VOXEL];
    const an = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const k = an[1] >= an[0] && an[1] >= an[2] ? 1 : an[0] >= an[2] ? 0 : 2;
    const sign = Math.sign([n.x, n.y, n.z][k]) || 1;
    let first = null;
    for (const d of [0.05, 0.5, 0.95]) {
      const v = [p[0] - n.x * d, p[1] - n.y * d, p[2] - n.z * d].map(Math.floor);
      if (this.world.isSolid(...v)) return v;
      // Grazing a face: also try straight back along its main axis.
      const c = p.slice();
      c[k] -= sign * d;
      const u = c.map(Math.floor);
      if (this.world.isSolid(...u)) return u;
      first = first || v;
    }
    return first;
  }

  /**
   * What left mouse breaks: { cells, leaves }.
   *  - Pieces and ground break on the 1 m grid, whatever you hold: the whole
   *    piece within the metre cell you aim at (see edits.breakCells).
   *  - Leaves break in the shape of the held item, on its grid: a 1 m item
   *    clears the leaves of a whole metre, a small block one voxel.
   */
  breakTarget(item) {
    const v = this.aimedVoxel();
    if (!this.hit.leaf) return { cells: breakCells(this.world, ...v), leaves: false };
    const L = item.shape ? item.shape.lattice : [1, 1, 1];
    const o = v.map((c, j) => Math.floor(c / L[j]) * L[j]);
    const cells = [];
    for (let z = o[2]; z < o[2] + L[2]; z++)
      for (let y = o[1]; y < o[1] + L[1]; y++)
        for (let x = o[0]; x < o[0] + L[0]; x++) if (PLANT_KIND[this.world.getPlant(x, y, z)] >= 2) cells.push([x, y, z]);
    return { cells, leaves: true };
  }

  // ---- per frame -------------------------------------------------------------

  update(dt, active, shift) {
    this.shift = shift;
    const item = this.item;
    this.hit = active && item ? this.raycast(item.kind === 'tool' ? TOOL_REACH : BUILD_REACH) : null;
    this.updateGizmos();
    if (!this.hit || !item) return;

    if (item.kind !== 'tool') {
      if (this.lmb || this.rmb) {
        this.repeat -= dt;
        if (this.repeat <= 0) {
          this.itemAction(this.lmb);
          this.repeat = REPEAT_RATE;
        }
      }
      return;
    }

    if (!this.lmb && !this.rmb) return;
    this.brushAccum += dt;
    if (this.brushAccum < 1 / BRUSH_HZ) return;
    const bdt = Math.min(this.brushAccum, 0.1);
    this.brushAccum = 0;
    this.applyTool(item, bdt);
  }

  // ---- building ----------------------------------------------------------------

  /** Left (primary) or right mouse with a building or plant item. */
  itemAction(primary) {
    const item = this.item;
    if (!this.hit || !item) return;
    const grass = item.kind === 'plant' && item.plant !== PLANT.LEAVES;
    if (primary) {
      if (grass && !this.hit.leaf) this.plantAction('remove');
      else this.breakAction();
    } else if (item.kind === 'build') this.buildAction(this.shift ? 'paint' : 'place');
    else this.plantAction('place');
  }

  breakAction() {
    const { cells, leaves } = this.breakTarget(this.item);
    if (!cells.length) return;
    if (!leaves) {
      clearCells(this.world, cells);
      return;
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [x, y, z] of cells) {
      this.world.setPlant(x, y, z, 0);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    this.world.markDirtyBox(x0, y0, z0, x1, y1, z1);
  }

  buildAction(kind) {
    const item = this.item;
    const w = this.world;
    if (kind === 'place') {
      const p = this.shapeTarget(item);
      if (p.blocked || this.blocksPlayer(p)) return;
      placeShape(w, p, item.material);
    } else {
      // Paint: recolour what left mouse would break.
      const { cells, leaves } = this.breakTarget(item);
      if (leaves) return;
      let changed = false;
      for (const [x, y, z] of cells) {
        if (w.getMat(x, y, z) === item.material) continue;
        w.setMat(x, y, z, item.material);
        w.markDirtyBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);
        changed = true;
      }
      if (!changed) return;
    }
    if (MATERIALS[item.material].natural) this.lastNatural = item.material;
  }

  // ---- plants ----------------------------------------------------------------

  /** Leaves: a 1 m block of leaf voxels on the build grid. Grass: a small brush. */
  plantAction(kind) {
    const item = this.item;
    if (!this.hit || !item || item.kind !== 'plant') return;
    const w = this.world;
    if (item.plant === PLANT.LEAVES) {
      if (kind !== 'place') return; // breaking is breakAction
      const p = this.shapeTarget(item);
      if (p.blocked) return;
      for (const [x, y, z] of p.voxels) if (!w.isSolid(x, y, z)) w.setPlant(x, y, z, PLANT.LEAVES);
      w.markDirtyBox(p.origin[0], p.origin[1], p.origin[2], p.origin[0] + p.size[0] - 1, p.origin[1] + p.size[1] - 1, p.origin[2] + p.size[2] - 1);
      return;
    }
    // Grass: every column within the brush, in the empty voxel on the ground nearest the aim.
    const r = item.radius / VOXEL;
    const c = { x: this.hit.point.x / VOXEL, y: this.hit.point.y / VOXEL, z: this.hit.point.z / VOXEL };
    let changed = false;
    for (let z = Math.floor(c.z - r); z <= Math.floor(c.z + r); z++)
      for (let x = Math.floor(c.x - r); x <= Math.floor(c.x + r); x++) {
        if (Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) > r) continue;
        for (let dy = 0; dy <= 6; dy++) {
          const y = Math.floor(c.y) + (dy % 2 ? (dy + 1) / 2 : -dy / 2);
          const here = w.getPlant(x, y, z);
          if (kind === 'remove') {
            if (PLANT_KIND[here] === 1) { w.setPlant(x, y, z, 0); changed = true; break; }
          } else if (supportsPlant(w, x, y, z, item.plant)) {
            if (!here) { w.setPlant(x, y, z, item.plant); changed = true; }
            break;
          }
        }
      }
    if (changed) w.markDirtyBox(Math.floor(c.x - r), Math.floor(c.y) - 4, Math.floor(c.z - r), Math.floor(c.x + r), Math.floor(c.y) + 4, Math.floor(c.z + r));
  }

  /** Placing may not make anything solid inside the player. */
  blocksPlayer(p) {
    return shapeSolidVoxels(this.world, p).some(([x, y, z]) => this.player.intersectsVoxel(x, y, z));
  }

  // ---- tools ---------------------------------------------------------------------

  /** Brushes never make terrain solid within half a voxel of the player. */
  protect = (x, y, z) => this.player.intersectsVoxel(x, y, z, VOXEL * 0.5);

  applyTool(item, dt) {
    const w = this.world;
    const r = this.radiusOf(item) / VOXEL; // voxels
    const { point, normal: n } = this.hit;
    const opts = { protect: this.protect };
    // Digging tools also clear the leaves you aim at, within the brush.
    if (this.hit.leaf && this.lmb && (item.id === 'pickaxe' || item.id === 'shovel')) {
      const c = this.hit.leaf.map((v) => v + 0.5);
      for (let z = Math.floor(c[2] - r); z <= Math.floor(c[2] + r); z++)
        for (let y = Math.floor(c[1] - r); y <= Math.floor(c[1] + r); y++)
          for (let x = Math.floor(c[0] - r); x <= Math.floor(c[0] + r); x++)
            if (Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1], z + 0.5 - c[2]) <= r && PLANT_KIND[w.getPlant(x, y, z)] >= 2) w.setPlant(x, y, z, 0);
      w.markDirtyBox(Math.floor(c[0] - r), Math.floor(c[1] - r), Math.floor(c[2] - r), Math.floor(c[0] + r), Math.floor(c[1] + r), Math.floor(c[2] + r));
      return;
    }
    if (item.id === 'pickaxe' || item.id === 'shovel') {
      // The sphere sits just across the surface, overlapping it by `step`:
      // inside the ground to raise, outside it to dig. So the surface moves at
      // a steady speed while the button is held.
      const step = Math.min(r, (DIG_SPEED / VOXEL) * dt);
      const raise = item.id === 'shovel' && this.rmb && !this.lmb;
      const off = (raise ? -1 : 1) * (r - step);
      const c = { x: point.x / VOXEL + n.x * off, y: point.y / VOXEL + n.y * off, z: point.z / VOXEL + n.z * off };
      sculptSphere(w, c, r, raise ? 'add' : 'sub', this.lastNatural, opts);
    } else if (item.id === 'trowel') {
      smoothBrush(w, { x: point.x / VOXEL, y: point.y / VOXEL, z: point.z / VOXEL }, r, dt, opts);
    } else if (item.id === 'level' && this.flattenY !== null) {
      flattenBrush(w, { x: point.x / VOXEL, y: 0, z: point.z / VOXEL }, r, this.flattenY / VOXEL, this.lastNatural, opts);
    }
  }

  // ---- gizmos ----------------------------------------------------------------------

  updateGizmos() {
    const { ghost, ghostEdges, brush, ring, disc } = this;
    ghost.visible = ghostEdges.visible = brush.visible = ring.visible = disc.visible = false;
    const item = this.item;
    if (!this.hit || !item) return;

    const grass = item.kind === 'plant' && item.plant !== PLANT.LEAVES;
    if (item.kind !== 'tool' && (!grass || this.hit.leaf)) {
      // Breaking (left mouse held, or aiming at leaves with grass) or painting
      // (Shift): outline what would go. Otherwise: the piece about to be placed.
      const painting = item.kind === 'build' && this.shift;
      if (this.lmb || painting || grass) {
        const { cells } = this.breakTarget(item);
        if (!cells.length) return;
        const { mesh, edges, origin } = this.cellsGhost(cells);
        this.showGhost(mesh, edges, origin, painting && !this.lmb ? materialColor(item.material) : REMOVE_COLOR, true);
        return;
      }
      const p = this.shapeTarget(item);
      const { mesh, edges } = this.ghostGeometry(p);
      const blocked = p.blocked || (item.kind === 'build' && this.blocksPlayer(p));
      const color = blocked ? BLOCKED_COLOR : item.kind === 'build' ? materialColor(item.material) : LEAF_COLOR;
      this.showGhost(mesh, edges, p.origin, color, !blocked);
      return;
    }

    const r = item.kind === 'plant' ? item.radius : this.radiusOf(item);
    const p = this.hit.point;
    const color = { pickaxe: 0xff8a7c, shovel: this.rmb ? 0x7cff8a : 0xffb07c, trowel: 0x7cd8ff, level: 0xffd34d }[item.id] ?? 0x9be07a;
    if (item.id === 'level') {
      const y = this.flattenY ?? Math.round(p.y);
      disc.position.set(p.x, y + 0.02, p.z);
      disc.scale.setScalar(r);
      disc.visible = true;
      ring.position.set(p.x, y + 0.03, p.z);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    } else {
      brush.position.copy(p);
      brush.scale.setScalar(r);
      brush.material.color.setHex(color);
      brush.visible = item.kind === 'tool';
      ring.position.copy(p).addScaledVector(this.hit.normal, 0.03);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.hit.normal);
    }
    ring.scale.setScalar(r);
    ring.material.color.setHex(color);
    ring.visible = true;
  }

  showGhost(mesh, edges, origin, color, withEdges) {
    const { ghost, ghostEdges } = this;
    ghost.geometry = mesh;
    ghostEdges.geometry = edges;
    ghost.position.set(origin[0] * VOXEL, origin[1] * VOXEL, origin[2] * VOXEL);
    ghostEdges.position.copy(ghost.position);
    this.ghostMat.color.copy(color);
    ghost.visible = true;
    ghostEdges.visible = withEdges;
  }

  /** Ghost of a set of voxels about to be broken: pieces in their own shapes, the rest as cubes. */
  cellsGhost(cells) {
    const origin = [0, 1, 2].map((j) => Math.min(...cells.map((c) => c[j])));
    const rel = cells.map(([x, y, z]) => [x - origin[0], y - origin[1], z - origin[2], this.world.getShape(x, y, z) || CUBE]);
    const key = 'cells:' + rel.map((c) => c.join(',')).sort().join(';');
    let g = this.ghostCache.get(key);
    if (!g) {
      const w = new World(1, 1, 1, 8);
      for (const [x, y, z, st] of rel) w.setVoxel(x + 3, y + 3, z + 3, MAT.PLANKS, st);
      g = this.meshGhost(w);
      this.ghostCache.set(key, g);
    }
    return { ...g, origin };
  }

  meshGhost(w) {
    const crisp = new Float32Array(256).fill(1);
    const m = meshChunk(w.buildPadded(0, 0, 0), crisp, VOXEL);
    const pos = m.position;
    for (let i = 0; i < pos.length; i++) pos[i] -= 3 * VOXEL; // shape origin at local 0
    const mesh = new THREE.BufferGeometry();
    mesh.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return { mesh, edges: new THREE.EdgesGeometry(mesh, 30) };
  }

  /** Mesh of a shape on its own (local coordinates, metres), cached per orientation. */
  ghostGeometry(p) {
    const key = `${p.shape.id}:${p.rot}:${p.flip}`;
    let g = this.ghostCache.get(key);
    if (g) return g;
    // Build it exactly as the world would: place the shape into a tiny empty world and mesh it.
    const w = new World(1, 1, 1, 8);
    placeShape(w, placement(p.shape, [3, 3, 3], p.rot, p.flip), MAT.PLANKS);
    g = this.meshGhost(w);
    this.ghostCache.set(key, g);
    return g;
  }
}
