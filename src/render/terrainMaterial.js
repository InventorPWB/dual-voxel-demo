import * as THREE from 'three';
import { MATERIALS } from '../world/materials.js';
import { textureArray } from './textureArray.js';
import { LIGHTING_GLSL, lightingUniforms } from './lighting.js';
import { DEPTH_PARAMS, HIDDEN } from './SunShadow.js';

export { SKY_COLOR, SUN_AZIMUTH, SUN_ELEVATION, sunDirection } from './lighting.js';

const SURFACE_GLSL = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // Triplanar pixel-art texturing, one tile per metre in world space, so
  // brick and plank patterns line up across neighbouring shapes.
  vec4 triplanar(vec3 pos, vec3 n, int mat) {
    // Nudge sample points off exact grid faces so nearest filtering is stable.
    vec3 p = pos - n * 0.001;
    // Each face takes the projection it leans toward, and projections only
    // mix in a thin seam where two are about equally square-on (the usual
    // pow(n, k) weights smear two angles over a wide slope). The seam is
    // roughened per texel, so it's a ragged dissolve, not a hard line.
    vec3 a = abs(n);
    vec3 q = floor(p * 32.0);
    a += (vec3(hash31(q), hash31(q + 7.1), hash31(q + 13.3)) - 0.5) * 0.12;
    vec3 w = clamp((a - max(a.x, max(a.y, a.z))) / 0.1 + 1.0, 0.0, 1.0);
    w /= (w.x + w.y + w.z);
    vec3 L = uLayers[mat];
    // A material with its own side texture (grass over dirt) shows it only on
    // near-vertical faces: on a slope the side projection would paint the
    // dirt half of it across the hillside. The change-over is dithered.
    float sideLayer = L.y;
    if (L.x != L.y && n.y > 0.0 && length(n.xz) + (hash31(floor(p * 16.0)) - 0.5) * 0.1 < 0.95) sideLayer = L.x;
    vec4 cx = texture(uTex, vec3(p.z, p.y, sideLayer));
    vec4 cy = texture(uTex, vec3(p.x, p.z, n.y >= 0.0 ? L.x : L.z));
    vec4 cz = texture(uTex, vec3(p.x, p.y, sideLayer));
    return cx * w.x + cy * w.y + cz * w.z;
  }

  // Smooth terrain where materials meet: the triangle's three corners each
  // stand for a material (mats), and w is where this pixel is between them.
  // The weights are roughened by noise per half texel and then sharpened
  // (a "height blend"), so the border is a ragged, pixel-art dissolve about a
  // cell wide instead of a flat cross-fade. Pure areas stay pure.
  vec4 terrainTexture(vec3 pos, vec3 n, ivec3 mats, vec3 w) {
    if (mats.x == mats.y && mats.y == mats.z) return triplanar(pos, n, mats.x);
    vec3 q = floor((pos - n * 0.001) * 16.0);
    vec3 jitter = vec3(hash31(q), hash31(q + 19.7), hash31(q + 47.3)) - 0.5;
    vec3 s = w + jitter * 0.55;
    vec3 b = max(s - (max(s.x, max(s.y, s.z)) - 0.3), 0.0);
    b /= (b.x + b.y + b.z);
    return triplanar(pos, n, mats.x) * b.x + triplanar(pos, n, mats.y) * b.y + triplanar(pos, n, mats.z) * b.z;
  }

  // One texture over a whole building piece, following its shape. local.xyz:
  // the point within the piece (0..1 per axis); local.w: 1 box or wedge,
  // 2 round (pillar), 3 sphere. Also draws the material's frame, if any,
  // along the piece's outline (a square on boxes, a circle on pillar caps).
  vec4 pieceTexture(vec3 n, vec4 local, int mat) {
    vec3 l = local.xyz;
    int kind = int(local.w + 0.5);
    vec3 L = uLayers[mat];
    vec3 a = abs(n);
    bool vertical = a.y >= a.x && a.y >= a.z;
    float capLayer = n.y >= 0.0 ? L.x : L.z;
    vec2 uv;
    float layer, edge;
    if (kind == 2 && !vertical) {
      // Round side: wrapped round the pillar's axis, about 1 tile per metre.
      float turn = atan(l.z - 0.5, l.x - 0.5) / 6.2831853 + 0.5;
      uv = vec2(turn * 3.0, l.y);
      layer = L.y;
      edge = min(l.y, 1.0 - l.y);
    } else if (kind == 2) {
      uv = l.xz;
      layer = capLayer;
      edge = 0.5 - length(l.xz - 0.5);
    } else {
      uv = vertical ? l.xz : a.x >= a.z ? l.zy : l.xy;
      layer = vertical ? capLayer : L.y;
      edge = kind == 3 ? 1.0 : min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    }
    vec4 c = texture(uTex, vec3(uv, layer));
    vec4 frame = uFrame[mat];
    if (frame.a > 0.0 && edge < 0.045) c = frame;
    return c;
  }

  vec4 surface(vec3 pos, vec3 n, vec4 local, int mat) {
    if (local.w > 0.5 && uPieceMap[mat] > 0.5) return pieceTexture(n, local, mat);
    return triplanar(pos, n, mat);
  }
`;

/**
 * Materials for the solid chunk meshes, one per render pass (the mesher's
 * groups): [opaque, cutout, translucent]. All share one shader and the
 * shared lighting, so blocks, shaped pieces, smooth terrain and glass sit in
 * the same light and cast and receive the same shadows.
 *  - cutout (glass): alpha-tested, front faces only
 *    (like Minecraft: you don't see a block's far side through it);
 *  - translucent (stained glass): blended, no depth writes, front faces only.
 * Also returns matching depth-only materials for the sun's shadow map:
 * glass frames cast shadows, stained glass casts none.
 */
export function createChunkMaterials(shadow) {
  const { texture, layerOf } = textureArray();
  const layers = MATERIALS.map((m) =>
    m.id === 0 ? new THREE.Vector3() : new THREE.Vector3(layerOf(m.top), layerOf(m.side), layerOf(m.bottom)),
  );
  const frames = MATERIALS.map((m) => new THREE.Vector4(...(m.frame || [0, 0, 0, 0])));
  const pieceMap = MATERIALS.map((m) => (m.mapping === 'piece' ? 1 : 0));
  const shared = {
    uTex: { value: texture }, uLayers: { value: layers }, uFrame: { value: frames }, uPieceMap: { value: pieceMap },
  };
  const head = /* glsl */ `
    precision highp sampler2DArray;
    uniform sampler2DArray uTex;
    uniform vec3 uLayers[${layers.length}];
    uniform vec4 uFrame[${layers.length}];
    uniform float uPieceMap[${layers.length}];
  `;

  const vertexShader = /* glsl */ `
    in float material;
    in float blend;
    in float ao;
    in vec4 local;
    out vec3 vPos;
    out vec3 vNormal;
    out vec4 vLocal;
    flat out int vMat;
    flat out int vBlend;
    out vec3 vCorner;
    out float vAo;
    out float vDepth;
    void main() {
      vPos = position;
      vLocal = local;
      vNormal = normal;
      vMat = int(material + 0.5);
      vBlend = int(blend + 0.5);
      // Which corner of its triangle this vertex is (meshes are not indexed).
      int corner = gl_VertexID % 3;
      vCorner = vec3(corner == 0 ? 1.0 : 0.0, corner == 1 ? 1.0 : 0.0, corner == 2 ? 1.0 : 0.0);
      vAo = ao;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;

  const fragmentShader = /* glsl */ `
    ${head}
    ${LIGHTING_GLSL}
    ${SURFACE_GLSL}
    in vec3 vPos;
    in vec3 vNormal;
    in vec4 vLocal;
    flat in int vMat;
    flat in int vBlend;
    in vec3 vCorner;
    in float vAo;
    in float vDepth;
    layout(location = 0) out vec4 outColor;

    void main() {
      vec3 n = normalize(vNormal);
      vec4 tex;
      if (vBlend > 0) tex = terrainTexture(vPos, n, ivec3(vBlend & 255, (vBlend >> 8) & 255, (vBlend >> 16) & 255), vCorner);
      else tex = surface(vPos, n, vLocal, vMat);
      vec3 color = fog(shade(tex.rgb, vPos, n, vAo, 0.2, 0.0), vDepth);
      #if defined(CUTOUT)
        if (cutout(tex.a)) discard;
        outColor = vec4(color, 1.0);
      #elif defined(TRANSLUCENT)
        outColor = vec4(color, tex.a);
      #else
        outColor = vec4(color, 1.0);
      #endif
    }
  `;

  const make = (defines, extra) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines,
    uniforms: { ...lightingUniforms(shadow), ...shared },
    vertexShader,
    fragmentShader,
    ...extra,
  });

  const materials = [
    make({}, {}),
    make({ CUTOUT: '' }, {}),
    make({ TRANSLUCENT: '' }, { transparent: true, depthWrite: false }),
  ];

  // Shadow casters: opaque as plain depth; glass alpha-tested so only its frame casts.
  const cutoutDepth = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: shared,
    vertexShader: /* glsl */ `
      in float material;
      in vec4 local;
      out vec3 vPos;
      out vec3 vNormal;
      out vec4 vLocal;
      flat out int vMat;
      void main() {
        vPos = position;
        vNormal = normal;
        vLocal = local;
        vMat = int(material + 0.5);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${head}
      ${SURFACE_GLSL}
      in vec3 vPos;
      in vec3 vNormal;
      in vec4 vLocal;
      flat in int vMat;
      layout(location = 0) out vec4 outColor;
      void main() {
        if (surface(vPos, normalize(vNormal), vLocal, vMat).a < 0.5) discard;
        outColor = vec4(1.0);
      }
    `,
    ...DEPTH_PARAMS,
  });
  const shadowMaterials = [new THREE.MeshBasicMaterial(DEPTH_PARAMS), cutoutDepth, HIDDEN];

  return { materials, shadowMaterials };
}
