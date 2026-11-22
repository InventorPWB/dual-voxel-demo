import * as THREE from 'three';
import { TEX_SIZE, TEXTURE_NAMES, texturePixels } from './textures.js';

let shared = null;

/**
 * Every procedural texture in one texture array, layer i = TEXTURE_NAMES[i]
 * (the mesh workers use the same order for plant layers). Shared by the
 * terrain, glass and foliage materials.
 */
export function textureArray() {
  if (shared) return shared;
  const S = TEX_SIZE;
  const data = new Uint8Array(S * S * 4 * TEXTURE_NAMES.length);
  TEXTURE_NAMES.forEach((name, layer) => {
    const px = texturePixels(name);
    // Flip rows so image "up" maps to +v (world up on side faces, a plant card's top).
    for (let y = 0; y < S; y++) {
      const src = y * S * 4;
      const dst = layer * S * S * 4 + (S - 1 - y) * S * 4;
      data.set(px.subarray(src, src + S * 4), dst);
    }
  });
  const tex = new THREE.DataArrayTexture(data, S, S, TEXTURE_NAMES.length);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  shared = { texture: tex, layerOf: (name) => TEXTURE_NAMES.indexOf(name) };
  return shared;
}
