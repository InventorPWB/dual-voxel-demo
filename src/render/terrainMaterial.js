import * as THREE from 'three';
import { MATERIALS } from '../world/materials.js';
import { textureArray } from './textureArray.js';
import { LIGHTING_GLSL, lightingUniforms, litMaterial } from './lighting.js';
import { DEPTH_PARAMS, HIDDEN } from './SunShadow.js';
import { WATER_GLSL } from './waterHeight.js';

export { SKY_COLOR, SUN_AZIMUTH, SUN_ELEVATION, sunDirection } from './lighting.js';

const SURFACE_GLSL = /* glsl */ `
  // A surface sample: colour (with alpha), shading normal (world), roughness, height.
  struct Surf { vec4 col; vec3 n; float rough; float h; };

  // Screen-space derivatives of the world position, taken once in main()
  // (outside any branch), so every lookup below can use textureGrad.
  vec3 gDpx;
  vec3 gDpy;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  vec3 unpackNormal(vec4 nrh) {
    vec2 xy = (nrh.rg * 2.0 - 1.0) * uNormalStrength;
    return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
  }

  // One planar projection of a layer: uvm is the point in the projection's
  // plane (metres), gx/gy its screen derivatives. Scaled to the layer's real
  // size. Natural ground breaks up its tiling ("texture bombing", after
  // Inigo Quilez): a slow noise picks one of eight offsets of the texture,
  // and the change-over between two neighbouring ones follows the texture's
  // own height, so it reads as more ground, not as a seam.
  void sampleLayer(vec2 uvm, vec2 gx, vec2 gy, float layer, out vec4 col, out vec4 nrh) {
    int li = int(layer + 0.5);
    float s = uLayerScale[li];
    vec2 uv = uvm * s;
    gx *= s;
    gy *= s;
    if (uLayerStoch[li] > 0.5) {
      float k = vnoise(uvm * 0.55 + layer * 13.7) * 0.6 + vnoise(uvm * 1.7 - layer * 5.1) * 0.4;
      float l = k * 8.0, ia = floor(l), f = fract(l);
      vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * (ia + 1.0));
      vec4 ca = textureGrad(uTex, vec3(uv + oa, layer), gx, gy);
      vec4 cb = textureGrad(uTex, vec3(uv + ob, layer), gx, gy);
      vec4 na = textureGrad(uNrm, vec3(uv + oa, layer), gx, gy);
      vec4 nb = textureGrad(uNrm, vec3(uv + ob, layer), gx, gy);
      float t = smoothstep(0.25, 0.75, f + (nb.a - na.a) * 0.6);
      col = mix(ca, cb, t);
      nrh = mix(na, nb, t);
    } else {
      col = textureGrad(uTex, vec3(uv, layer), gx, gy);
      nrh = textureGrad(uNrm, vec3(uv, layer), gx, gy);
    }
  }

  #ifndef PIXEL_ART
  // Triplanar texturing in world space, each material at its real size, so
  // brick and plank patterns line up across neighbouring shapes. Normal maps
  // are carried into world space with the "whiteout" blend per projection.
  Surf triplanar(vec3 pos, vec3 n, int mat) {
    vec3 p = pos;
    // Each face takes the projection it leans toward, and projections only
    // mix in a thin seam where two are about equally square-on (the usual
    // pow(n, k) weights smear two angles over a wide slope). The seam wanders
    // with a little noise, so it isn't a straight line.
    vec3 a = abs(n);
    vec2 sp = p.xz + p.y * vec2(0.7, -1.3);
    a += (vec3(vnoise(sp * 3.1), vnoise(sp * 3.1 + 17.0), vnoise(sp * 3.1 + 41.0)) - 0.5) * 0.12;
    vec3 w = clamp((a - max(a.x, max(a.y, a.z))) / 0.12 + 1.0, 0.0, 1.0);
    w /= (w.x + w.y + w.z);
    vec3 L = uLayers[mat];
    // A material with its own side texture (grass over dirt) shows it only on
    // near-vertical faces: on a slope the side projection would paint the
    // dirt half of it across the hillside. The change-over wanders with noise.
    float sideLayer = L.y;
    if (L.x != L.y && n.y > 0.0 && length(n.xz) + (vnoise(sp * 2.3) - 0.5) * 0.12 < 0.95) sideLayer = L.x;
    Surf o;
    o.col = vec4(0.0);
    vec3 nsum = vec3(0.0);
    o.rough = 0.0;
    o.h = 0.0;
    vec4 c, q;
    vec3 t;
    if (w.x > 0.0) {
      sampleLayer(p.zy, gDpx.zy, gDpy.zy, sideLayer, c, q);
      t = unpackNormal(q);
      nsum += vec3(t.xy + n.zy, abs(t.z) * n.x).zyx * w.x;
      o.col += c * w.x; o.rough += q.b * w.x; o.h += q.a * w.x;
    }
    if (w.y > 0.0) {
      sampleLayer(p.xz, gDpx.xz, gDpy.xz, n.y >= 0.0 ? L.x : L.z, c, q);
      t = unpackNormal(q);
      nsum += vec3(t.xy + n.xz, abs(t.z) * n.y).xzy * w.y;
      o.col += c * w.y; o.rough += q.b * w.y; o.h += q.a * w.y;
    }
    if (w.z > 0.0) {
      sampleLayer(p.xy, gDpx.xy, gDpy.xy, sideLayer, c, q);
      t = unpackNormal(q);
      nsum += vec3(t.xy + n.xy, abs(t.z) * n.z) * w.z;
      o.col += c * w.z; o.rough += q.b * w.z; o.h += q.a * w.z;
    }
    o.n = normalize(nsum);
    return o;
  }

  // Smooth terrain where materials meet: the triangle's three corners each
  // stand for a material (mats), and w is where this pixel is between them.
  // Height blend: each material's weight is raised by its own height map, and
  // only the highest stay, so grass gives way to dirt between its tufts and
  // stone pokes up through the soil, rather than the two cross-fading.
  // Pure areas stay pure.
  Surf terrainTexture(vec3 pos, vec3 n, ivec3 mats, vec3 w) {
    if (mats.x == mats.y && mats.y == mats.z) return triplanar(pos, n, mats.x);
    Surf a = triplanar(pos, n, mats.x), b = triplanar(pos, n, mats.y), c = triplanar(pos, n, mats.z);
    // The border wanders (two octaves of noise), so it doesn't trace the
    // voxel grid's steps.
    vec2 sp = pos.xz + pos.y * vec2(0.7, -1.3);
    vec3 jitter = vec3(vnoise(sp * 2.1), vnoise(sp * 2.1 + 9.0), vnoise(sp * 2.1 + 27.0)) * 0.65
      + vec3(vnoise(sp * 6.3 + 3.0), vnoise(sp * 6.3 + 51.0), vnoise(sp * 6.3 + 77.0)) * 0.35 - 0.5;
    // (Scaled down to nothing where a material's weight is: along the edge a
    // blend triangle shares with a pure one, so there's no seam there.)
    vec3 s = w + (vec3(a.h, b.h, c.h) * 0.8 + jitter * 0.7 - 0.4) * min(w * 3.0, 1.0);
    vec3 k = max(s - (max(s.x, max(s.y, s.z)) - 0.15), 0.0);
    k /= (k.x + k.y + k.z);
    Surf o;
    o.col = a.col * k.x + b.col * k.y + c.col * k.z;
    o.n = normalize(a.n * k.x + b.n * k.y + c.n * k.z);
    o.rough = a.rough * k.x + b.rough * k.y + c.rough * k.z;
    o.h = a.h * k.x + b.h * k.y + c.h * k.z;
    return o;
  }
  #else
  // ---- the 32×32 pixel-art textures, drawn as they always were ----

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // Triplanar pixel-art texturing, one tile per metre in world space, so
  // brick and plank patterns line up across neighbouring shapes.
  Surf triplanar(vec3 pos, vec3 n, int mat) {
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
    return Surf(cx * w.x + cy * w.y + cz * w.z, n, 1.0, 0.5);
  }

  // Smooth terrain where materials meet: the triangle's three corners each
  // stand for a material (mats), and w is where this pixel is between them.
  // The weights are roughened by noise per half texel and then sharpened
  // (a "height blend"), so the border is a ragged, pixel-art dissolve about a
  // cell wide instead of a flat cross-fade. Pure areas stay pure.
  Surf terrainTexture(vec3 pos, vec3 n, ivec3 mats, vec3 w) {
    if (mats.x == mats.y && mats.y == mats.z) return triplanar(pos, n, mats.x);
    vec3 q = floor((pos - n * 0.001) * 16.0);
    vec3 jitter = vec3(hash31(q), hash31(q + 19.7), hash31(q + 47.3)) - 0.5;
    vec3 s = w + jitter * 0.55;
    vec3 b = max(s - (max(s.x, max(s.y, s.z)) - 0.3), 0.0);
    b /= (b.x + b.y + b.z);
    vec4 c = triplanar(pos, n, mats.x).col * b.x + triplanar(pos, n, mats.y).col * b.y + triplanar(pos, n, mats.z).col * b.z;
    return Surf(c, n, 1.0, 0.5);
  }
  #endif

  // One texture over a whole building piece, following its shape. local.xyz:
  // the point within the piece (0..1 per axis); local.w: 1 box or wedge,
  // 2 round (pillar), 3 sphere. Also draws the material's frame, if any,
  // along the piece's outline (a square on boxes, a circle on pillar caps).
  Surf pieceTexture(vec3 n, vec4 local, int mat) {
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
    Surf o;
    o.col = texture(uTex, vec3(uv, layer));
    vec4 q = texture(uNrm, vec3(uv, layer));
    o.n = n;
    o.rough = q.b;
    o.h = q.a;
    vec4 frame = uFrame[mat];
    if (frame.a > 0.0 && edge < 0.045) { o.col = frame; o.rough = 0.55; }
    return o;
  }

  Surf surface(vec3 pos, vec3 n, vec4 local, int mat) {
    if (local.w > 0.5 && uPieceMap[mat] > 0.5) return pieceTexture(n, local, mat);
    return triplanar(pos, n, mat);
  }

  // Large-scale variation over natural ground (uMacro[mat] = 1; building
  // materials get a little), so no two stretches of a field are the same
  // shade: lighter and darker patches tens of metres across, and drier,
  // yellower ones.
  vec3 macroVariation(vec3 albedo, vec3 pos, int mat) {
    float amount = uMacro[mat];
    vec2 p = pos.xz;
    float m = vnoise(p * 0.045) * 0.55 + vnoise(p * 0.17 + 31.0) * 0.3 + vnoise(p * 0.6 - 7.0) * 0.15;
    albedo *= 1.0 + (m - 0.5) * 0.6 * amount;
    float dry = smoothstep(0.45, 0.85, vnoise(p * 0.06 + 113.0));
    albedo = mix(albedo, albedo * vec3(1.14, 1.03, 0.76), dry * 0.7 * amount);
    return albedo;
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
export function createChunkMaterials(shadow, water = null) {
  const waterUniforms = water ? water.uniforms : {
    uWaterHeight: { value: new THREE.DataTexture(new Float32Array([-1000, 0]), 1, 1, THREE.RGFormat, THREE.FloatType) },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uWaterOn: { value: 0 },
  };
  const { photo, texture, normals, layerOf, layerScale, layerStoch } = textureArray();
  // Without the photographic textures: the pixel-art texturing and lighting.
  const mode = photo ? {} : { PIXEL_ART: '' };
  const layers = MATERIALS.map((m) =>
    m.id === 0 ? new THREE.Vector3() : new THREE.Vector3(layerOf(m.top), layerOf(m.side), layerOf(m.bottom)),
  );
  const frames = MATERIALS.map((m) => new THREE.Vector4(...(m.frame || [0, 0, 0, 0])));
  const pieceMap = MATERIALS.map((m) => (m.mapping === 'piece' ? 1 : 0));
  const macro = MATERIALS.map((m) => (m.natural ? 1 : 0.3));
  // Specular level (shader lighting): grass and soil keep most of their
  // reflection in their own gaps; stone, brick and glass show all of it.
  const SPECULAR = { grass_top: 0.25, dirt: 0.5, sand: 0.6, planks: 0.8 };
  const specular = MATERIALS.map((m) => SPECULAR[m.top] ?? 1);
  const shared = {
    uTex: { value: texture }, uNrm: { value: normals }, uLayers: { value: layers }, uFrame: { value: frames },
    uPieceMap: { value: pieceMap }, uMacro: { value: macro }, uSpecular: { value: specular },
    uNormalStrength: lightingUniforms(shadow).uNormalStrength, uLayerScale: { value: layerScale }, uLayerStoch: { value: layerStoch },
  };
  const head = /* glsl */ `
    precision highp sampler2DArray;
    uniform sampler2DArray uTex;
    uniform sampler2DArray uNrm;
    uniform vec3 uLayers[${layers.length}];
    uniform vec4 uFrame[${layers.length}];
    uniform float uPieceMap[${layers.length}];
    uniform float uMacro[${layers.length}];
    uniform float uSpecular[${layers.length}];
    uniform float uNormalStrength;
    uniform float uLayerScale[${layerScale.length}];
    uniform float uLayerStoch[${layerScale.length}];
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
    uniform float uTime;
    ${WATER_GLSL}
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
      gDpx = dFdx(vPos);
      gDpy = dFdy(vPos);
      vec3 n = normalize(vNormal);
      Surf s;
      if (vBlend > 0) s = terrainTexture(vPos, n, ivec3(vBlend & 255, (vBlend >> 8) & 255, (vBlend >> 16) & 255), vCorner);
      else s = surface(vPos, n, vLocal, vMat);
      vec4 tex = s.col;
      // Water: ground under it is wet (a little darker, glossier), fading in
      // over the first few centimetres so the waterline isn't a hard edge.
      float under = underWater(vPos);
      float wet = smoothstep(0.0, 0.05, under) * (tex.a > 0.5 ? 1.0 : 0.0);
      // Shallow water is drawn right here on the ground: dark, glossy, tinted,
      // with streaks where it runs downhill. It follows the smooth ground
      // exactly, however the voxels step.
      vec2 runDir;
      float run;
      float film = waterFilm(vPos, runDir, run) * (tex.a > 0.5 ? 1.0 : 0.0);
      wet = max(wet, film);
      #ifdef PIXEL_ART
        vec3 color = fog(shade(tex.rgb * mix(1.0, 0.8, wet) * mix(vec3(1.0), vec3(0.6, 0.75, 0.85), film), vPos, n, vAo, 0.2, 0.0), vDepth, vPos);
      #else
        vec3 albedo = macroVariation(tex.rgb, vPos, vBlend > 0 ? vBlend & 255 : vMat) * mix(1.0, 0.8, wet);
        albedo *= mix(vec3(1.0), vec3(0.55, 0.7, 0.8), film);
        int sm = vBlend > 0 ? vBlend & 255 : vMat;
        vec3 color = shadeSurface(albedo, vPos, n, s.n, vAo, 0.2, mix(s.rough * mix(1.0, 0.5, wet), 0.08, film), mix(uSpecular[sm], 1.0, film));
        #ifdef HDR
          // Caustics on what's under water: the sun focused by the ripples, fading with depth.
          if (under > 0.0) color += sunLight() * albedo * caustics(vPos.xz, uTime) * 0.5 * wet * exp(-under * 0.5) * max(n.y, 0.0) * smoothstep(0.0, 0.3, uSunDir.y);
          if (film * run > 0.0) {
            // Streaks of white water carried downhill.
            vec2 q = vec2(dot(vPos.xz, vec2(-runDir.y, runDir.x)), dot(vPos.xz, runDir));
            float streak = vnoise(vec2(q.x * 7.0, q.y * 1.2 - uTime * 2.2)) * vnoise(vec2(q.x * 3.0 + 4.0, q.y * 0.6 - uTime * 1.4));
            color += (sunLight() * 0.06 + skyAmbient(vec3(0.0, 1.0, 0.0)) * 0.25) * smoothstep(0.25, 0.6, streak) * film * run;
          }
        #endif
        color = fog(color, vDepth, vPos);
      #endif
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

  const make = (defines, extra) => litMaterial(new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { ...mode, ...defines },
    uniforms: { ...lightingUniforms(shadow), ...shared, ...waterUniforms },
    vertexShader,
    fragmentShader,
    ...extra,
  }));

  const materials = [
    make({}, {}),
    make({ CUTOUT: '' }, {}),
    make({ TRANSLUCENT: '' }, { transparent: true, depthWrite: false }),
  ];

  // Shadow casters: opaque as plain depth; glass alpha-tested so only its frame casts.
  const cutoutDepth = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: mode,
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
        gDpx = dFdx(vPos);
        gDpy = dFdy(vPos);
        if (surface(vPos, normalize(vNormal), vLocal, vMat).col.a < 0.5) discard;
        outColor = vec4(1.0);
      }
    `,
    ...DEPTH_PARAMS,
  });
  const shadowMaterials = [new THREE.MeshBasicMaterial(DEPTH_PARAMS), cutoutDepth, HIDDEN];

  return { materials, shadowMaterials };
}
