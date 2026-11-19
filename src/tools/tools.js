import * as THREE from 'three';
import { MATERIALS } from '../world/materials.js';
import { averageColor } from '../render/textures.js';
import { stampSphere, stepForSpeed, smoothBrush, flattenBrush, paintBrush, placeAt, removeAt } from '../world/edits.js';

/** How fast Sculpt moves the surface while held, in metres per second. */
const SCULPT_SPEED = 3;

export const TOOLS = [
  { id: 'build', name: 'Build', key: 'Z', hint: 'LMB remove block · RMB place block' },
  { id: 'sculpt', name: 'Sculpt', key: 'X', hint: 'LMB dig · RMB raise' },
  { id: 'smooth', name: 'Smooth', key: 'C', hint: 'LMB smooth surface' },
  { id: 'flatten', name: 'Flatten', key: 'V', hint: 'LMB flatten to the height you clicked' },
  { id: 'paint', name: 'Paint', key: 'B', hint: 'LMB paint material' },
];

const BUILD_REACH = 9;
const BRUSH_REACH = 48;
const BRUSH_HZ = 40; // brush edits per second
const REPEAT_DELAY = 0.28;
const REPEAT_RATE = 0.16;

const swatch = MATERIALS.map((m) => (m.id ? new THREE.Color(...averageColor(m.top)) : new THREE.Color()));

/**
 * Tool state, targeting and edits. Every tool writes the same voxels
 * (occupancy + material); there is no separate terrain or building layer.
 */
export class ToolSystem {
  constructor({ world, scene, camera, chunkMeshes, player, onChange }) {
    this.world = world;
    this.camera = camera;
    this.chunkMeshes = chunkMeshes;
    this.player = player;
    this.onChange = onChange;

    this.tool = 0;
    this.material = 5; // planks
    this.radius = 3;
    this.lmb = false;
    this.rmb = false;
    this.hit = null;
    this.flattenY = null;
    this.brushAccum = 0;
    this.repeat = 0;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.center = new THREE.Vector2(0, 0);

    // Gizmos
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.012, 1.012, 1.012)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.outline.renderOrder = 11;
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(0.98, 0.98, 0.98),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false }),
    );
    this.brush = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
    );
    // Outer ring (a filled annulus, since WebGL lines are always 1px).
    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.93, 1, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
    );
    this.brushRing.renderOrder = 10;
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
    );
    for (const g of [this.outline, this.ghost, this.brush, this.brushRing, this.disc]) {
      g.visible = false;
      scene.add(g);
    }
  }

  get toolId() {
    return TOOLS[this.tool].id;
  }

  setTool(i) {
    this.tool = (i + TOOLS.length) % TOOLS.length;
    this.flattenY = null;
    this.onChange?.();
  }

  setMaterial(id) {
    const n = MATERIALS.length - 1;
    this.material = ((id - 1 + n) % n) + 1;
    this.onChange?.();
  }

  setRadius(r) {
    this.radius = Math.max(1, Math.min(8, r));
    this.onChange?.();
  }

  mouseDown(button) {
    if (button === 0) this.lmb = true;
    if (button === 2) this.rmb = true;
    if (this.toolId === 'build') {
      this.buildAction(button === 0 ? 'remove' : 'place');
      this.repeat = REPEAT_DELAY;
    } else {
      if (this.toolId === 'flatten' && button === 0 && this.hit) this.flattenY = Math.round(this.hit.point.y);
      this.brushAccum = 1 / BRUSH_HZ; // apply immediately
    }
  }

  mouseUp(button) {
    if (button === 0) this.lmb = false;
    if (button === 2) this.rmb = false;
    if (!this.lmb) this.flattenY = null;
  }

  releaseAll() {
    this.lmb = this.rmb = false;
    this.flattenY = null;
  }

  // ---- targeting -----------------------------------------------------------

  raycast() {
    const reach = this.toolId === 'build' ? BUILD_REACH : BRUSH_REACH;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.center, this.camera);
    this.raycaster.far = reach;
    const hits = this.raycaster.intersectObjects(this.chunkMeshes.list, false);
    if (!hits.length) return null;
    const h = hits[0];
    const n = h.face.normal.clone();
    return { point: h.point.clone(), normal: n };
  }

  buildTargets() {
    const { point: p, normal: n } = this.hit;
    const remove = [Math.floor(p.x - n.x * 0.5), Math.floor(p.y - n.y * 0.5), Math.floor(p.z - n.z * 0.5)];
    const place = [Math.floor(p.x + n.x * 0.5), Math.floor(p.y + n.y * 0.5), Math.floor(p.z + n.z * 0.5)];
    return { remove, place };
  }

  // ---- per frame -------------------------------------------------------------

  update(dt, active) {
    this.hit = active ? this.raycast() : null;
    this.updateGizmos();
    if (!active || !this.hit) return;

    if (this.toolId === 'build') {
      if (this.lmb || this.rmb) {
        this.repeat -= dt;
        if (this.repeat <= 0) {
          this.buildAction(this.lmb ? 'remove' : 'place');
          this.repeat = REPEAT_RATE;
        }
      }
      return;
    }

    if (!this.lmb && !this.rmb) return;
    this.brushAccum += dt;
    const step = 1 / BRUSH_HZ;
    if (this.brushAccum < step) return;
    const bdt = Math.min(this.brushAccum, 0.1);
    this.brushAccum = 0;
    this.applyBrush(bdt);
  }

  updateGizmos() {
    const { outline, ghost, brush, brushRing, disc } = this;
    outline.visible = ghost.visible = brush.visible = brushRing.visible = disc.visible = false;
    if (!this.hit) return;

    if (this.toolId === 'build') {
      const { remove, place } = this.buildTargets();
      if (this.world.isSolid(...remove)) {
        outline.position.set(remove[0] + 0.5, remove[1] + 0.5, remove[2] + 0.5);
        outline.visible = true;
      }
      if (this.world.inBounds(...place) && !this.player.intersectsVoxel(...place)) {
        ghost.position.set(place[0] + 0.5, place[1] + 0.5, place[2] + 0.5);
        ghost.material.color.copy(swatch[this.material]);
        ghost.visible = true;
      }
      return;
    }

    const r = this.radius;
    const p = this.hit.point;
    const color = {
      sculpt: this.rmb ? 0x7cff8a : 0xff8a7c,
      smooth: 0x7cd8ff,
      flatten: 0xffd34d,
      paint: swatch[this.material].getHex(),
    }[this.toolId];

    if (this.toolId === 'flatten') {
      const y = this.flattenY ?? Math.round(p.y);
      disc.position.set(p.x, y + 0.02, p.z);
      disc.scale.setScalar(r);
      disc.visible = true;
      brushRing.position.set(p.x, y + 0.03, p.z);
      brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    } else {
      brush.position.copy(p);
      brush.scale.setScalar(r);
      brush.material.color.setHex(color);
      brush.visible = true;
      // Ring lies on the surface, facing out along the hit normal.
      brushRing.position.copy(p).addScaledVector(this.hit.normal, 0.03);
      brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.hit.normal);
    }
    brushRing.scale.setScalar(r);
    brushRing.material.color.setHex(color);
    brushRing.visible = true;
  }

  // ---- edits ------------------------------------------------------------------

  buildAction(kind) {
    if (!this.hit) return;
    const { remove, place } = this.buildTargets();
    // Rules for every block/terrain combination live in world/edits.js.
    if (kind === 'remove') {
      removeAt(this.world, ...remove);
    } else {
      if (this.player.intersectsVoxel(...place)) return;
      placeAt(this.world, ...place, this.material, { protect: this.protect });
    }
  }

  /**
   * Voxels terrain may not become solid in: anything within half a voxel of the
   * player's box. The margin matters because the smooth surface extends up to
   * ~0.4 m beyond a solid voxel into its capped neighbour.
   */
  protect = (x, y, z) => this.player.intersectsVoxel(x, y, z, 0.5);

  applyBrush(dt) {
    const w = this.world;
    const r = this.radius;
    const { point: c, normal: n } = this.hit;
    const tool = this.toolId;
    if (tool === 'flatten' && this.flattenY === null) return;

    // Brushes start just in front of the aimed-at surface; blocks between
    // there and a voxel shield it (see world/edits.js).
    const opts = { seed: [c.x + n.x * 0.3, c.y + n.y * 0.3, c.z + n.z * 0.3], protect: this.protect };

    if (tool === 'sculpt') {
      // Smoothly union (raise) or subtract (dig) a sphere the size of the brush,
      // moving the surface at a steady speed while held.
      const raise = this.rmb && !this.lmb;
      stampSphere(w, c.x, c.y, c.z, r, raise ? 'add' : 'sub', stepForSpeed(SCULPT_SPEED, dt), this.material, opts);
    } else if (tool === 'smooth') {
      smoothBrush(w, c, r, dt, opts);
    } else if (tool === 'flatten') {
      flattenBrush(w, c, r, this.flattenY, dt, opts);
    } else if (tool === 'paint') {
      paintBrush(w, c, r, this.material, opts);
    }
  }
}
