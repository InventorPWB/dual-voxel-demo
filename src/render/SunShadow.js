import * as THREE from 'three';

/** Layer the chunk meshes are on so the shadow pass skips ghosts, rings and other overlays. */
export const SHADOW_LAYER = 1;

const BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

/**
 * One orthographic shadow map from the sun, fitted to the bounds of the whole
 * voxel world. The world is small (128 m across), so a single 4096² map gives
 * texels of a few centimetres. That's finer than the 6 cm texture pixels, so no
 * cascades are needed.
 *
 * The sun and the world are static most of the time, so the map is only
 * re-rendered when a chunk mesh changes or the sun moves, not every frame.
 * When nothing changes, shadows cost only the lookups in the terrain shader.
 */
export class SunShadow {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.size = Math.min(4096, renderer.capabilities.maxTextureSize);

    const depth = new THREE.DepthTexture(this.size, this.size, THREE.UnsignedIntType);
    // Comparison sampling: each lookup gets a hardware 2×2 bilinear PCF.
    depth.compareFunction = THREE.LessEqualCompare;
    depth.minFilter = depth.magFilter = THREE.LinearFilter;
    this.target = new THREE.WebGLRenderTarget(this.size, this.size, { depthTexture: depth, samples: 0 });
    this.target.texture.generateMipmaps = false;

    this.camera = new THREE.OrthographicCamera();
    this.camera.layers.set(SHADOW_LAYER);

    // Depth only. Both sides are drawn so open edges of the world (and any
    // surface whose back faces the sun) still block light. A slope-scaled
    // polygon offset plus the shader's normal offset keep the surfaces from
    // shadowing themselves.
    this.depthMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.5,
      polygonOffsetUnits: 2,
    });

    this.direction = new THREE.Vector3(0, 1, 0); // towards the sun
    this.matrix = new THREE.Matrix4(); // world → shadow-map UV + depth
    this.texel = new THREE.Vector2(1 / this.size, 0.05); // (uv per texel, metres per texel)
    this.dirty = true;
    this.renders = 0;
    this.lastMs = 0;

    this.box = new THREE.Box3();
    this.corner = new THREE.Vector3();
  }

  get texture() {
    return this.target.depthTexture;
  }

  setDirection(dir) {
    if (this.direction.distanceToSquared(dir) < 1e-12) return;
    this.direction.copy(dir).normalize();
    this.dirty = true;
  }

  /** Re-render the map if anything changed since the last call. */
  update(meshes) {
    if (!this.dirty) return false;
    this.dirty = false;
    const t0 = performance.now();

    const box = this.box.makeEmpty();
    for (const m of meshes) if (m.geometry.boundingBox) box.union(m.geometry.boundingBox);
    if (box.isEmpty()) return false;
    this.fit(box);

    const { renderer, scene } = this;
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    scene.overrideMaterial = this.depthMaterial;
    scene.background = null;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    this.renders++;
    this.lastMs = performance.now() - t0;
    return true;
  }

  /** Aim the light camera along the sun and fit its frustum tightly around `box`. */
  fit(box) {
    const cam = this.camera;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    // Keep the map's "up" roughly along world +z so texels stay square-ish on the ground.
    cam.up.set(0, 0, 1);
    if (Math.abs(this.direction.z) > 0.99) cam.up.set(1, 0, 0);
    cam.position.copy(center).addScaledVector(this.direction, radius + 10);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);

    // Bounds of the box in light view space.
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = this.corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(inv);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const pad = 1;
    cam.left = x0 - pad; cam.right = x1 + pad;
    cam.bottom = y0 - pad; cam.top = y1 + pad;
    cam.near = Math.max(0.1, -z1 - pad);
    cam.far = -z0 + pad;
    cam.updateProjectionMatrix();

    this.texel.y = Math.max(cam.right - cam.left, cam.top - cam.bottom) / this.size;
    this.matrix.multiplyMatrices(BIAS, cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  }

  dispose() {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}
