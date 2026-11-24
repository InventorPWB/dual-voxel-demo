import * as THREE from 'three';
import { VOXEL } from '../world/World.js';

/** Value for columns with no water. */
const DRY = -1000;

/**
 * The water over every column, as a texture the ground's shader reads
 * (terrainMaterial.js) for what's under water: a little darker (wet) and lit
 * by caustics. Per column, the height (metres) of the top water surface (red)
 * and how deep the water is there (green); dry columns next to water take
 * its level with no depth. Ground below the level but deeper than the water
 * (down a slope from a lake, say) isn't under it. Rebuilt from FluidCore's column survey when that
 * changes (at most a few times a second).
 */
export class WaterHeight {
  constructor(world, core) {
    this.world = world;
    this.core = core;
    const { sx, sz } = world;
    // Half floats, so it can be filtered smoothly between columns.
    this.half = new Uint16Array(sx * sz * 2);
    const dry = THREE.DataUtils.toHalfFloat(DRY);
    for (let c = 0; c < sx * sz; c++) this.half[c * 2] = dry;
    this.texture = new THREE.DataTexture(this.half, sx, sz, THREE.RGFormat, THREE.HalfFloatType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.version = -1;
    this.enabled = true;
    this.uniforms = {
      uWaterHeight: { value: this.texture },
      uWorldSize: { value: new THREE.Vector2(sx * VOXEL, sz * VOXEL) },
      uWaterOn: { value: 1 },
      // Paint shallow water on the ground (waterFilm): for the cellular water, whose
      // mesher leaves it out. The contoured surface draws it itself.
      uFilmOn: { value: 1 },
    };
  }

  setEnabled(on) {
    this.enabled = on;
    this.uniforms.uWaterOn.value = on ? 1 : 0;
  }

  update() {
    if (!this.enabled || this.core.version === this.version) return;
    this.version = this.core.version;
    const { sx, sz } = this.world;
    const s = this.core.surf, d = this.core.depth, h = this.half, toHalf = THREE.DataUtils.toHalfFloat;
    const level = new Float32Array(sx * sz), depth = new Float32Array(sx * sz);
    for (let c = 0; c < sx * sz; c++) {
      const wet = s[c] >= 0;
      level[c] = wet ? s[c] * VOXEL : DRY;
      depth[c] = wet ? d[c] * VOXEL : 0;
    }
    // Dry columns beside water take its level, with no depth: so where the
    // water's edge crosses them is decided by the ground's height there
    // (smooth), not by which column holds water (0.5 m steps). With no depth,
    // only ground just under the level counts, so a slope dropping away from
    // the water stays dry.
    for (let k = 0; k < 2; k++) {
      const prev = level.slice();
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const c = x + sx * z;
          if (prev[c] > DRY) continue;
          let best = DRY;
          if (x > 0) best = Math.max(best, prev[c - 1]);
          if (x < sx - 1) best = Math.max(best, prev[c + 1]);
          if (z > 0) best = Math.max(best, prev[c - sx]);
          if (z < sz - 1) best = Math.max(best, prev[c + sx]);
          level[c] = best;
        }
    }
    for (let c = 0; c < sx * sz; c++) {
      h[c * 2] = toHalf(level[c]);
      h[c * 2 + 1] = toHalf(depth[c]);
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * GLSL for the ground's shader: needs uniforms uWaterHeight, uWorldSize,
 * uWaterOn and uTime (lighting.js). underWater(p): how far below the water's
 * surface p is (metres), or a negative number if it isn't under water.
 */
export const WATER_GLSL = /* glsl */ `
  uniform highp sampler2D uWaterHeight;
  uniform vec2 uWorldSize;
  uniform float uWaterOn;
  uniform float uFilmOn;
  float underWater(vec3 p) {
    if (uWaterOn < 0.5) return -1.0;
    vec2 w = texture(uWaterHeight, p.xz / uWorldSize).rg;
    // (Where water meets a dry column, filtering mixes in the "dry" value: not under.)
    if (w.r < -100.0) return -1.0;
    float below = w.r - p.y;
    // Only within the water that's actually there (plus a little for the
    // smooth ground poking about in its voxels), not anything lower nearby.
    return below <= w.g + 0.25 ? below : -1.0;
  }
  // How level the water over p is (1 level, 0 steep: a cascade). Under steep
  // water the columns' levels differ a lot, and blending them makes blobs.
  float waterLevelness(vec3 p) {
    vec2 uv = p.xz / uWorldSize, e = vec2(0.5, 0.0) / uWorldSize;
    float a = texture(uWaterHeight, uv - e.xy).r, b = texture(uWaterHeight, uv + e.xy).r;
    float c = texture(uWaterHeight, uv - e.yx).r, d = texture(uWaterHeight, uv + e.yx).r;
    if (min(min(a, b), min(c, d)) < -100.0) return 1.0;
    return 1.0 - smoothstep(0.1, 0.25, length(vec2(b - a, d - c)));
  }
  // Shallow water, drawn on the ground itself rather than as a surface (the
  // water surface fades out below about 18 cm): how much (0..1), and, where it
  // runs downhill, which way (unit xz, out) and how much it's running (0..1, out).
  float waterFilm(vec3 p, out vec2 dir, out float run) {
    dir = vec2(0.0);
    run = 0.0;
    if (uWaterOn < 0.5 || uFilmOn < 0.5) return 0.0;
    vec2 uv = p.xz / uWorldSize;
    vec2 w = texture(uWaterHeight, uv).rg;
    if (w.r < -100.0 || w.g <= 0.003 || w.r - p.y < -0.08) return 0.0;
    // Slope of the surface, from the wet columns either side.
    vec2 e = vec2(0.5, 0.0) / uWorldSize;
    vec2 a = texture(uWaterHeight, uv - e.xy).rg, b = texture(uWaterHeight, uv + e.xy).rg;
    vec2 c = texture(uWaterHeight, uv - e.yx).rg, d = texture(uWaterHeight, uv + e.yx).rg;
    float hx0 = a.g > 0.0 ? a.r : w.r, hx1 = b.g > 0.0 ? b.r : w.r;
    float hz0 = c.g > 0.0 ? c.r : w.r, hz1 = d.g > 0.0 ? d.r : w.r;
    vec2 g = vec2(hx1 - hx0, hz1 - hz0);
    float slope = length(g);
    if (slope > 1e-4) {
      dir = -g / slope;
      run = smoothstep(0.03, 0.08, slope);
    }
    return (1.0 - smoothstep(0.14, 0.22, w.g)) * smoothstep(0.0, 0.01, w.g);
  }
  // Caustics: bright lines of sunlight focused by the ripples, drifting.
  float caustics(vec2 p, float t) {
    float c = 0.0;
    for (int i = 0; i < 2; i++) {
      vec2 q = p * (1.4 + float(i) * 0.9) + vec2(t * 0.31, -t * 0.23) * (1.0 + float(i));
      vec2 w = sin(q + sin(q.yx * 1.7 + t * 0.6) * 1.3);
      c += pow(1.0 - abs(w.x * w.y), 6.0);
    }
    return c * 0.5;
  }
`;
