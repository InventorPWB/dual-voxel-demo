import * as THREE from 'three';
import { textureArray } from './textureArray.js';
import { averageColor } from './textures.js';
import { LIGHTING_GLSL, lightingUniforms } from './lighting.js';
import { DEPTH_PARAMS, HIDDEN } from './SunShadow.js';

/** Grass is drawn fully out to FADE_START metres and gone by FADE_END. */
const FADE_START = 40, FADE_END = 60;
/**
 * From BLEND_START to BLEND_END metres grass takes on the colour of the grass
 * ground under it, as games do: distant blades are thinner than a pixel, so
 * any contrast with the ground shimmers as speckles and outlines.
 */
const BLEND_START = 10, BLEND_END = 38;

const SWAY_GLSL = /* glsl */ `
  uniform float uTime;
  // Wind: a slow gust travelling across the world plus a quicker flutter.
  vec3 sway(vec3 p, float wind) {
    float w = wind * wind;
    float gust = sin(uTime * 1.3 + p.x * 0.21 + p.z * 0.17) * 0.5 + 0.5;
    float flutter = sin(uTime * 4.7 + p.x * 1.9 + p.z * 2.3 + p.y);
    return vec3(0.07 * gust + 0.025 * flutter, 0.0, 0.05 * gust + 0.02 * flutter) * w;
  }
`;

/**
 * Materials for the foliage meshes (src/mesh/foliage.js), by group:
 * [grass/flowers, leaves]. Alpha-tested cutout cards, drawn from
 * both sides, swaying in the wind, lit by the shared lighting. Leaves let a
 * little sun through from behind. Grass thins out and vanishes with distance,
 * where the ground's own grass texture carries the colour.
 *
 * Shadows: grass casts none (too fine to matter, too costly); leaves cast
 * them without the sway, so the shadow map doesn't need redrawing every frame.
 */
export function createFoliageMaterials(shadow) {
  const { texture, layerOf } = textureArray();
  const head = /* glsl */ `
    precision highp sampler2DArray;
    uniform sampler2DArray uTex;
  `;
  const vertexShader = /* glsl */ `
    ${SWAY_GLSL}
    in vec3 uvl;
    in float wind;
    in float ao;
    in float seed;
    out vec3 vPos;
    out vec3 vNormal;
    out vec3 vUvl;
    out float vAo;
    out float vDepth;
    out float vFar;
    void main() {
      float vFade;
      vec3 p = position + sway(position, wind);
      vPos = p;
      vNormal = normal;
      vUvl = uvl;
      vAo = ao;
      float dist = distance(position, cameraPosition);
      #ifdef GRASS
        // Thin out with distance a whole clump at a time (each has its own
        // seed), so far grass doesn't turn to per-pixel noise.
        vFade = 1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, dist);
        vFar = smoothstep(${BLEND_START.toFixed(1)}, ${BLEND_END.toFixed(1)}, dist);
      #else
        vFade = 1.0;
        vFar = 0.0;
      #endif
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
      // Faded out: collapse the card so it costs nothing to rasterise.
      if (seed >= vFade) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    }
  `;
  const fragmentShader = /* glsl */ `
    ${head}
    ${LIGHTING_GLSL}
    in vec3 vPos;
    in vec3 vNormal;
    in vec3 vUvl;
    in float vAo;
    in float vDepth;
    in float vFar;
    uniform float uHullLayer;
    uniform vec3 uGroundTint;
    layout(location = 0) out vec4 outColor;
    void main() {
      vec3 n = normalize(vNormal);
      vec4 tex;
      #ifdef LEAVES
        if (abs(vUvl.z - uHullLayer) < 0.5) {
          // The crown's core: triplanar from world position, one tile per metre.
          vec3 w = pow(abs(n), vec3(4.0));
          w /= w.x + w.y + w.z;
          tex = texture(uTex, vec3(vPos.zy, uHullLayer)) * w.x
              + texture(uTex, vec3(vPos.xz, uHullLayer)) * w.y
              + texture(uTex, vec3(vPos.xy, uHullLayer)) * w.z;
        } else tex = texture(uTex, vUvl);
      #else
        tex = texture(uTex, vUvl);
      #endif
      if (cutout(tex.a)) discard;
      #ifdef LEAVES
        vec3 color = shade(tex.rgb, vPos, n, vAo, 0.45, 1.0);
      #else
        // Far away: the ground's own colour and light, so blades melt into it.
        vec3 albedo = mix(tex.rgb, uGroundTint, vFar * 0.85);
        vec3 color = shade(albedo, vPos, n, mix(vAo, 1.0, vFar), 0.3, 0.0);
      #endif
      outColor = vec4(fog(color, vDepth), 1.0);
    }
  `;
  const make = (defines) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines,
    uniforms: {
      ...lightingUniforms(shadow), uTex: { value: texture },
      uHullLayer: { value: layerOf('leaves_hull') }, uGroundTint: { value: new THREE.Vector3(...averageColor('grass_top')) },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  });
  const materials = [make({ GRASS: '' }), make({ LEAVES: '' })];

  const leafDepth = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uTex: { value: texture } },
    vertexShader: /* glsl */ `
      in vec3 uvl;
      out vec3 vUvl;
      void main() {
        vUvl = uvl;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${head}
      in vec3 vUvl;
      layout(location = 0) out vec4 outColor;
      void main() {
        if (texture(uTex, vUvl).a < 0.5) discard;
        outColor = vec4(1.0);
      }
    `,
    ...DEPTH_PARAMS,
  });

  return { materials, shadowMaterials: [HIDDEN, leafDepth] };
}
