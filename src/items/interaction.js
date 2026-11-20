import * as THREE from 'three';
import { World, VOXEL } from '../world/World.js';
import { MATERIALS, MAT } from '../world/materials.js';
import { placement, rotationForFacing } from '../world/shapes.js';
import {
  sculptSphere, smoothBrush, flattenBrush, placeShape, removeShape, shapeSolidVoxels,
} from '../world/edits.js';
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
    if (item.kind === 'build') {
      this.buildAction(button === 0 ? 'remove' : this.shift ? 'paint' : 'place');
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

  raycast(reach) {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    this.raycaster.far = reach;
    const h = this.raycaster.intersectObjects(this.chunkMeshes.list, false)[0];
    if (!h) return null;
    return { point: h.point.clone(), normal: h.face.normal.clone() };
  }

  /**
   * Where the held shape goes, Minecraft-style.
   *  - Along the face you aim at, it sits flush against it (placing) or
   *    reaches into it from the face (removing).
   *  - Across the face, it snaps to the item's build grid (1 m for 1 m
   *    pieces, 0.5 m for slabs and small blocks), lined up with the piece
   *    you aim at, or with the world grid when you aim at terrain.
   *  - On natural ground, pieces go to the nearest whole-metre level, so
   *    neighbours share a height; a gap under one is filled by a foundation.
   */
  shapeTarget(item, mode) {
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
    const size = placement(item.shape, [0, 0, 0], rot, flip).size;

    // The voxel behind the surface you're aiming at.
    const behind = p.map((v, j) => Math.floor(j === k ? v - sign * 0.05 : v));
    const onPiece = w.isPiece(...behind);
    const onGround = !onPiece && w.isTerrain(...behind);

    // Across the face, snap to the grid of the piece you're aiming at (its
    // corner, as stored in its voxels), or to the world grid on terrain.
    const pieceCorner = onPiece ? behind.map((v, j) => v - w.getPieceOffset(...behind)[j]) : [0, 0, 0];
    const origin = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      if (j === k) continue;
      const anchor = pieceCorner[j];
      origin[j] = anchor + Math.floor((p[j] - anchor) / L[j]) * L[j];
    }

    // Along the face: flush with a piece's face (on the voxel grid); on ground, a grid level.
    const face = onPiece ? Math.round(p[k]) : null;
    if (mode === 'place') {
      if (face !== null) origin[k] = sign > 0 ? face : face - size[k];
      else if (onGround && k === 1 && sign > 0) origin[k] = Math.round(p[k] / GROUND_LEVEL) * GROUND_LEVEL;
      else origin[k] = Math.floor((p[k] + sign * 0.05) / L[k]) * L[k];
    } else {
      if (face !== null) origin[k] = sign > 0 ? face - size[k] : face;
      else origin[k] = Math.floor((p[k] - sign * 0.05) / L[k]) * L[k];
    }

    const target = placement(item.shape, origin, rot, flip);
    target.onGround = mode === 'place' && onGround && k === 1 && sign > 0;
    return target;
  }

  // ---- per frame -------------------------------------------------------------

  update(dt, active, shift) {
    this.shift = shift;
    const item = this.item;
    this.hit = active && item ? this.raycast(item.kind === 'build' ? BUILD_REACH : TOOL_REACH) : null;
    this.updateGizmos();
    if (!this.hit || !item) return;

    if (item.kind === 'build') {
      if (this.lmb || this.rmb) {
        this.repeat -= dt;
        if (this.repeat <= 0) {
          this.buildAction(this.lmb ? 'remove' : this.shift ? 'paint' : 'place');
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

  buildAction(kind) {
    const item = this.item;
    if (!this.hit || !item || item.kind !== 'build') return;
    const w = this.world;
    if (kind === 'place') {
      const p = this.shapeTarget(item, 'place');
      if (this.blocksPlayer(p)) return;
      placeShape(w, p, item.material, { foundation: p.onGround });
    } else if (kind === 'remove') {
      removeShape(w, this.shapeTarget(item, 'remove'));
    } else {
      // Paint: recolour everything solid in the cell.
      const p = this.shapeTarget(item, 'remove');
      const [ox, oy, oz] = p.origin;
      let changed = false;
      for (let z = oz; z < oz + p.size[2]; z++)
        for (let y = oy; y < oy + p.size[1]; y++)
          for (let x = ox; x < ox + p.size[0]; x++) {
            const m = w.getMat(x, y, z);
            if (m && m !== item.material) { w.setMat(x, y, z, item.material); changed = true; }
          }
      if (changed) w.markDirtyBox(ox - 1, oy - 1, oz - 1, ox + p.size[0], oy + p.size[1], oz + p.size[2]);
    }
    if (MATERIALS[item.material].natural) this.lastNatural = item.material;
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

    if (item.kind === 'build') {
      // While left mouse (remove) or Shift (paint) is held, show the footprint in the surface.
      const into = this.lmb || this.shift;
      const p = this.shapeTarget(item, into ? 'remove' : 'place');
      const { mesh, edges } = this.ghostGeometry(p);
      ghost.geometry = mesh;
      ghostEdges.geometry = edges;
      ghost.position.set(p.origin[0] * VOXEL, p.origin[1] * VOXEL, p.origin[2] * VOXEL);
      ghostEdges.position.copy(ghost.position);
      const blocked = !into && this.blocksPlayer(p);
      this.ghostMat.color.copy(this.lmb ? REMOVE_COLOR : blocked ? BLOCKED_COLOR : materialColor(item.material));
      ghost.visible = true;
      ghostEdges.visible = !blocked;
      return;
    }

    const r = this.radiusOf(item);
    const p = this.hit.point;
    const color = { pickaxe: 0xff8a7c, shovel: this.rmb ? 0x7cff8a : 0xffb07c, trowel: 0x7cd8ff, level: 0xffd34d }[item.id];
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
      brush.visible = true;
      ring.position.copy(p).addScaledVector(this.hit.normal, 0.03);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.hit.normal);
    }
    ring.scale.setScalar(r);
    ring.material.color.setHex(color);
    ring.visible = true;
  }

  /** Mesh of a shape on its own (local coordinates, metres), cached per orientation. */
  ghostGeometry(p) {
    const key = `${p.shape.id}:${p.rot}:${p.flip}`;
    let g = this.ghostCache.get(key);
    if (g) return g;
    // Build it exactly as the world would: place the shape into a tiny empty world and mesh it.
    const w = new World(1, 1, 1, 8);
    placeShape(w, placement(p.shape, [3, 3, 3], p.rot, p.flip), MAT.PLANKS);
    const crisp = new Float32Array(256).fill(1);
    const m = meshChunk(w.buildPadded(0, 0, 0), crisp, VOXEL);
    const pos = m.position;
    for (let i = 0; i < pos.length; i++) pos[i] -= 3 * VOXEL; // shape origin at local 0
    const mesh = new THREE.BufferGeometry();
    mesh.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const edges = new THREE.EdgesGeometry(mesh, 30);
    g = { mesh, edges };
    this.ghostCache.set(key, g);
    return g;
  }
}
