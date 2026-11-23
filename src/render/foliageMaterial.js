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

/** Leaf cards carry their facing (`axis`); twigs, the other leaf-pass geometry, have none. */
const CARD_GLSL = /* glsl */ `
  in vec3 axis;
  bool isCard() {
    return dot(axis, axis) > 0.5;
  }
`;

/**
 * Whether to keep this fragment of a leaf card. Cards turned edge-on to you
 * drop their leaves as they turn, one whole leaf at a time in a scattered order
 * fixed per leaf (the rank layer gives each leaf of the texture its own
 * random rank), instead of smearing into streaks or being cut by a moving
 * edge. `plane` is the drawn triangle's plane.
 * `near` (0..1) thins cards right in front of the camera the same way, so
 * inside a crown you look through the leaves at arm's length, not at a
 * screenful of one card.
 * Needs uTex (the texture array) declared before it.
 */
const CARD_FADE_GLSL = /* glsl */ `
  uniform float uRankLayer;
  bool keepCard(vec3 plane, vec3 toViewer, vec2 uv, float near) {
    float f = abs(dot(normalize(plane), toViewer));
    float shown = smoothstep(0.06, 0.4, f) * near;
    if (shown >= 1.0) return true;
    // Full-size level: ranks are per leaf, not to be blurred (and this may
    // run in a branch, where implicit mip selection isn't defined).
    return textureLod(uTex, vec3(uv, uRankLayer), 0.0).r <= shown;
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
  const { photo, texture, normals, layerOf } = textureArray();
  const head = /* glsl */ `
    precision highp sampler2DArray;
    uniform sampler2DArray uTex;
    uniform sampler2DArray uNrm;
  `;
  const leafUniforms = { uRankLayer: { value: layerOf('leaves_rank') } };
  const vertexShader = /* glsl */ `
    ${SWAY_GLSL}
    #ifdef LEAVES
      ${CARD_GLSL}
    #endif
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
    out float vIsCard;
    out float vSeed;
    void main() {
      float vFade;
      vSeed = seed;
      #ifdef LEAVES
        vIsCard = isCard() ? 1.0 : 0.0;
      #else
        vIsCard = 0.0;
      #endif
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
      // (Leaves always have vFade = 1 and seeds below it.)
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
    in float vIsCard;
    in float vSeed;
    uniform vec3 uGroundTint;
    ${CARD_FADE_GLSL}
    layout(location = 0) out vec4 outColor;
    void main() {
      vec3 n = normalize(vNormal);
      vec4 tex;
      #ifdef LEAVES
        // Derivatives taken here, outside any branch: the card's plane, and
        // the bark's tangent frame (from how its uv runs across the screen).
        vec3 dpx = dFdx(vPos), dpy = dFdy(vPos);
        vec2 dux = dFdx(vUvl.xy), duy = dFdy(vUvl.xy);
        vec3 plane = cross(dpx, dpy);
        tex = texture(uTex, vUvl);
        if (vIsCard > 0.5) {
          float near = smoothstep(0.25, 1.1, distance(cameraPosition, vPos));
          if (!keepCard(plane, normalize(cameraPosition - vPos), vUvl.xy, near)) discard;
        }
      #else
        tex = texture(uTex, vUvl);
      #endif
      if (cutout(tex.a)) discard;
      #ifdef LEAVES
        vec3 color;
        if (vIsCard > 0.5) {
          // Leaves wrap light and let the sun through.
          color = shade(tex.rgb, vPos, n, vAo, 0.45, 1.0);
        } else {
          #ifdef PIXEL_ART
          // Bark: lit like terrain.
          color = shade(tex.rgb, vPos, n, vAo, 0.2, 0.0);
          #else
          // Bark: lit like terrain, with its normal and roughness maps
          // (cotangent frame from the derivatives, after Schüler).
          vec4 q = texture(uNrm, vUvl);
          vec3 t = vec3(q.rg * 2.0 - 1.0, 0.0);
          t.z = sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)));
          vec3 p2 = cross(dpy, n), p1 = cross(n, dpx);
          vec3 T = p2 * dux.x + p1 * duy.x, B = p2 * dux.y + p1 * duy.y;
          float m = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
          vec3 bn = normalize(mat3(T * m, B * m, n) * t);
          color = shadeSurface(tex.rgb, vPos, n, bn, vAo, 0.2, q.b);
          #endif
        }
      #else
        vec3 albedo = tex.rgb;
        #ifndef PIXEL_ART
        // Each clump a slightly different green: some lusher, some drier.
        float h = fract(vSeed * 7.31);
        albedo *= 0.88 + 0.22 * h;
        albedo = mix(albedo, albedo * vec3(1.08, 1.0, 0.8), smoothstep(0.7, 1.0, fract(vSeed * 3.17)) * 0.5);
        #endif
        // Far away: the ground's own colour and light, so blades melt into it.
        albedo = mix(albedo, uGroundTint, vFar * 0.85);
        vec3 color = shade(albedo, vPos, n, mix(vAo, 1.0, vFar), 0.3, 0.0);
      #endif
      outColor = vec4(fog(color, vDepth), 1.0);
    }
  `;
  const make = (defines) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    // Without the photographic textures: lit as the pixel art always was.
    defines: photo ? defines : { ...defines, PIXEL_ART: '' },
    uniforms: {
      ...lightingUniforms(shadow), uTex: { value: texture }, uNrm: { value: normals },
      ...leafUniforms, uGroundTint: { value: new THREE.Vector3(...averageColor('grass_top')) },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  });
  const materials = [make({ GRASS: '' }), make({ LEAVES: '' })];

  const leafDepth = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uTex: { value: texture }, ...leafUniforms },
    vertexShader: /* glsl */ `
      ${CARD_GLSL}
      in vec3 uvl;
      out vec3 vUvl;
      out vec3 vPos;
      out float vIsCard;
      void main() {
        vUvl = uvl;
        vPos = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
        vIsCard = isCard() ? 1.0 : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      ${head}
      ${CARD_FADE_GLSL}
      in vec3 vUvl;
      in float vIsCard;
      in vec3 vPos;
      layout(location = 0) out vec4 outColor;
      void main() {
        vec3 plane = cross(dFdx(vPos), dFdy(vPos));
        if (texture(uTex, vUvl).a < 0.5) discard;
        // Cards fade as the sun sees them, as they do for the camera
        // (the sun camera is orthographic: towards it is its view's +z).
        vec3 toSun = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        if (vIsCard > 0.5 && !keepCard(plane, toSun, vUvl.xy, 1.0)) discard;
        outColor = vec4(1.0);
      }
    `,
    ...DEPTH_PARAMS,
  });

  return { materials, shadowMaterials: [HIDDEN, leafDepth] };
}
