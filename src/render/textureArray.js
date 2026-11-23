import * as THREE from 'three';
import { TEX_SIZE, TEX_RES, TEXTURE_NAMES, hasPhotos, layerPixels, layerNRH, layerInfo, releaseNRH } from './textures.js';

let shared = null;

/**
 * Every texture in two parallel texture arrays, layer i = TEXTURE_NAMES[i]
 * (the mesh workers use the same order for plant layers), shared by the
 * terrain, glass and foliage materials:
 *  - `texture`: colour (and alpha, for cutouts and stained glass);
 *  - `normals`: normal x, y, roughness, height (see textures.js).
 * Also per layer: `layerScale` (tiles per metre in the world) and
 * `layerStoch` (1: break up its tiling); and `photo`: whether these are the
 * photographic textures (else the 32×32 pixel art, drawn as it always was).
 *
 * The colour array's mipmaps are made here rather than by the GPU (see
 * `mipChain`), so cutout textures (grass, flowers, leaves, glass) look right
 * at a distance. Call `attachMipmaps(renderer)` once to have them uploaded.
 */
export function textureArray() {
  if (shared) return shared;
  const photo = hasPhotos(); // photographic textures: bigger layers, smooth filtering
  const S = photo ? TEX_RES : TEX_SIZE;
  const L = TEXTURE_NAMES.length;
  const data = new Uint8Array(S * S * 4 * L);
  const nrm = new Uint8Array(S * S * 4 * L);
  // Flip rows so image "up" maps to +v (world up on side faces, a plant card's top).
  const put = (dst, px, layer) => {
    for (let y = 0; y < S; y++) {
      const src = y * S * 4;
      dst.set(px.subarray(src, src + S * 4), layer * S * S * 4 + (S - 1 - y) * S * 4);
    }
  };
  TEXTURE_NAMES.forEach((name, layer) => {
    put(data, layerPixels(name, S), layer);
    put(nrm, layerNRH(name, S), layer);
  });
  releaseNRH();
  const tex = new THREE.DataArrayTexture(data, S, S, L);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = photo ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = photo ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapLinearFilter;
  // Lets three allocate the levels; ours overwrite them right after (attachMipmaps).
  tex.generateMipmaps = true;
  tex.anisotropy = photo ? 8 : 4;
  tex.needsUpdate = true;

  const normals = new THREE.DataArrayTexture(nrm, S, S, L);
  normals.format = THREE.RGBAFormat;
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
  normals.magFilter = THREE.LinearFilter;
  normals.minFilter = THREE.LinearMipmapLinearFilter;
  normals.generateMipmaps = true;
  normals.anisotropy = photo ? 8 : 4;
  normals.needsUpdate = true;
  // Uploaded once: the copy here is only dead weight after that.
  normals.onUpdate = () => { normals.image.data = null; };

  const info = TEXTURE_NAMES.map(layerInfo);
  shared = {
    photo, texture: tex, normals, layerOf: (name) => TEXTURE_NAMES.indexOf(name),
    layerScale: info.map((i) => 1 / i.metres), layerStoch: info.map((i) => (i.stochastic ? 1 : 0)),
    mips: mipChain(data, S, L),
  };
  return shared;
}

/** Upload the hand-made mip levels whenever three uploads the texture. */
export function attachMipmaps(renderer) {
  const t = textureArray();
  const { texture } = t;
  texture.onUpdate = () => {
    // three has just uploaded level 0 and left the texture bound.
    const gl = renderer.getContext();
    t.mips.forEach((m, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, i + 1, 0, 0, 0, m.size, m.size, m.layers, gl.RGBA, gl.UNSIGNED_BYTE, m.data));
    // Uploaded once: free the copies (hundreds of MB with photo textures).
    t.mips = [];
    texture.image.data = null;
  };
}

/**
 * Mip levels 1.. of the array, for cutout textures done right:
 *  - colour is averaged weighted by alpha, so the (black, invisible) colour of
 *    holes never darkens or tints a texture's visible edges;
 *  - alpha is scaled per level so the share of texels that pass the cutout
 *    test stays what it is at full size (coverage-preserving mipmaps), so
 *    grass and leaves neither thin out nor turn to mush with distance.
 */
export function mipChain(data, size, layers) {
  const out = [];
  let src = data, s = size;
  // Coverage of each layer at full size: the target for every smaller level.
  const target = [];
  for (let l = 0; l < layers; l++) target.push(coverage(data, l * size * size * 4, size * size, 1));
  while (s > 1) {
    const h = s >> 1;
    const raw = new Uint8Array(h * h * 4 * layers);
    for (let l = 0; l < layers; l++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < h; x++) {
          let r = 0, g = 0, b = 0, a = 0, pr = 0, pg = 0, pb = 0;
          for (let k = 0; k < 4; k++) {
            const i = (l * s * s + (2 * y + (k >> 1)) * s + 2 * x + (k & 1)) * 4;
            const w = src[i + 3];
            r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; a += w;
            pr += src[i]; pg += src[i + 1]; pb += src[i + 2];
          }
          const o = (l * h * h + y * h + x) * 4;
          if (a > 0) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a; }
          else { raw[o] = pr / 4; raw[o + 1] = pg / 4; raw[o + 2] = pb / 4; }
          raw[o + 3] = a / 4;
        }
    // Scale alpha per layer to keep its coverage (the unscaled level feeds the next one).
    const level = raw.slice();
    for (let l = 0; l < layers; l++) {
      const at = l * h * h * 4, n = h * h;
      if (target[l] >= 1 || target[l] <= 0) continue;
      let lo = 0.5, hi = 8;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) / 2;
        if (coverage(raw, at, n, mid) < target[l]) lo = mid; else hi = mid;
      }
      for (let i = 0; i < n; i++) level[at + i * 4 + 3] = Math.min(255, raw[at + i * 4 + 3] * hi);
    }
    out.push({ size: h, layers, data: level });
    src = raw;
    s = h;
  }
  return out;
}

/** Share of `n` texels from byte offset `at` whose alpha × scale passes the cutout test. */
function coverage(data, at, n, scale) {
  let c = 0;
  for (let i = 0; i < n; i++) if (data[at + i * 4 + 3] * scale >= 127.5) c++;
  return c / n;
}
