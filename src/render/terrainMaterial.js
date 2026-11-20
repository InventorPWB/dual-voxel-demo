import * as THREE from 'three';
import { MATERIALS } from '../world/materials.js';
import { TEX_SIZE, texturePixels } from './textures.js';

export const SKY_COLOR = 0xa9cdee;

/**
 * The one material for the voxel world: triplanar-mapped pixel-art textures
 * from a texture array (one tile per metre in world space, so brick and plank
 * patterns line up across neighbouring shapes), wrap-Lambert sun +
 * hemisphere ambient, baked AO and fog.
 */
export function createTerrainMaterial() {
  // Build the texture array: one layer per distinct texture name.
  const names = [];
  const layerOf = (n) => {
    let i = names.indexOf(n);
    if (i < 0) { names.push(n); i = names.length - 1; }
    return i;
  };
  const layers = MATERIALS.map((m) =>
    m.id === 0 ? new THREE.Vector3() : new THREE.Vector3(layerOf(m.top), layerOf(m.side), layerOf(m.bottom)),
  );

  const S = TEX_SIZE;
  const data = new Uint8Array(S * S * 4 * names.length);
  names.forEach((name, layer) => {
    const px = texturePixels(name);
    // Flip rows so image "up" maps to +v (world up on side faces).
    for (let y = 0; y < S; y++) {
      const src = y * S * 4;
      const dst = layer * S * S * 4 + (S - 1 - y) * S * 4;
      data.set(px.subarray(src, src + S * 4), dst);
    }
  });
  const tex = new THREE.DataArrayTexture(data, S, S, names.length);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  const raw = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

  const params = {
    glslVersion: THREE.GLSL3,
    uniforms: {
      uTex: { value: tex },
      uLayers: { value: layers },
      uSunDir: { value: new THREE.Vector3(0.45, 0.8, 0.35).normalize() },
      uSunColor: { value: raw(0xfff1d6) },
      uSkyColor: { value: raw(0xc4dcf5) },
      uGroundColor: { value: raw(0x6b5a48) },
      uFogColor: { value: raw(SKY_COLOR) },
      uFogDensity: { value: 0.0085 },
    },
    vertexShader: /* glsl */ `
      in float material;
      in float ao;
      out vec3 vPos;
      out vec3 vNormal;
      flat out int vMat;
      out float vAo;
      out float vDepth;
      void main() {
        vPos = position;
        vNormal = normal;
        vMat = int(material + 0.5);
        vAo = ao;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray uTex;
      uniform vec3 uLayers[${layers.length}];
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uGroundColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      in vec3 vPos;
      in vec3 vNormal;
      flat in int vMat;
      in float vAo;
      in float vDepth;
      layout(location = 0) out vec4 outColor;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 w = pow(abs(n), vec3(8.0));
        w /= (w.x + w.y + w.z);
        vec3 L = uLayers[vMat];
        // Nudge sample points off exact grid faces so nearest filtering is stable.
        vec3 p = vPos - n * 0.001;
        vec3 cx = texture(uTex, vec3(p.z, p.y, L.y)).rgb;
        vec3 cy = texture(uTex, vec3(p.x, p.z, n.y >= 0.0 ? L.x : L.z)).rgb;
        vec3 cz = texture(uTex, vec3(p.x, p.y, L.y)).rgb;
        vec3 albedo = cx * w.x + cy * w.y + cz * w.z;

        // Half-Lambert-ish wrap keeps slopes facing away from the sun from going muddy.
        float sun = clamp(dot(n, uSunDir) * 0.8 + 0.2, 0.0, 1.0);
        vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
        vec3 light = hemi * 0.6 + uSunColor * sun * 0.6;
        vec3 color = albedo * light * vAo;

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        outColor = vec4(mix(color, uFogColor, f), 1.0);
      }
    `,
  };

  return new THREE.ShaderMaterial(params);
}
