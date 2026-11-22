import * as THREE from 'three';
import { MATERIALS } from '../world/materials.js';
import { textureArray } from './textureArray.js';
import { LIGHTING_GLSL, lightingUniforms } from './lighting.js';
import { DEPTH_PARAMS, HIDDEN } from './SunShadow.js';

export { SKY_COLOR, SUN_AZIMUTH, SUN_ELEVATION, sunDirection } from './lighting.js';

const TRIPLANAR_GLSL = /* glsl */ `
  // Triplanar pixel-art texturing, one tile per metre in world space, so
  // brick and plank patterns line up across neighbouring shapes.
  vec4 triplanar(vec3 pos, vec3 n, int mat) {
    vec3 w = pow(abs(n), vec3(8.0));
    w /= (w.x + w.y + w.z);
    vec3 L = uLayers[mat];
    // Nudge sample points off exact grid faces so nearest filtering is stable.
    vec3 p = pos - n * 0.001;
    vec4 cx = texture(uTex, vec3(p.z, p.y, L.y));
    vec4 cy = texture(uTex, vec3(p.x, p.z, n.y >= 0.0 ? L.x : L.z));
    vec4 cz = texture(uTex, vec3(p.x, p.y, L.y));
    return cx * w.x + cy * w.y + cz * w.z;
  }
`;

/**
 * Materials for the solid chunk meshes, one per render pass (the mesher's
 * groups): [opaque, cutout, translucent]. All share one shader and the
 * shared lighting, so blocks, shaped pieces, smooth terrain and glass sit in
 * the same light and cast and receive the same shadows.
 *  - cutout (glass): alpha-tested with alpha-to-coverage, drawn from both
 *    sides so a glass block's far frame shows through it;
 *  - translucent (stained glass): blended, no depth writes, front faces only.
 * Also returns matching depth-only materials for the sun's shadow map:
 * glass frames cast shadows, stained glass casts none.
 */
export function createChunkMaterials(shadow) {
  const { texture, layerOf } = textureArray();
  const layers = MATERIALS.map((m) =>
    m.id === 0 ? new THREE.Vector3() : new THREE.Vector3(layerOf(m.top), layerOf(m.side), layerOf(m.bottom)),
  );
  const shared = { uTex: { value: texture }, uLayers: { value: layers } };
  const head = /* glsl */ `
    precision highp sampler2DArray;
    uniform sampler2DArray uTex;
    uniform vec3 uLayers[${layers.length}];
  `;

  const vertexShader = /* glsl */ `
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
  `;

  const fragmentShader = /* glsl */ `
    ${head}
    ${LIGHTING_GLSL}
    ${TRIPLANAR_GLSL}
    in vec3 vPos;
    in vec3 vNormal;
    flat in int vMat;
    in float vAo;
    in float vDepth;
    layout(location = 0) out vec4 outColor;

    void main() {
      vec3 n = normalize(vNormal);
      #ifdef CUTOUT
        if (!gl_FrontFacing) n = -n;
      #endif
      vec4 tex = triplanar(vPos, n, vMat);
      vec3 color = fog(shade(tex.rgb, vPos, n, vAo, 0.2, 0.0), vDepth);
      #if defined(CUTOUT)
        float a = cutoutAlpha(tex.a);
        if (a <= 0.0) discard;
        outColor = vec4(color, a);
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
    make({ CUTOUT: '' }, { side: THREE.DoubleSide, alphaToCoverage: true }),
    make({ TRANSLUCENT: '' }, { transparent: true, depthWrite: false }),
  ];

  // Shadow casters: opaque as plain depth; glass alpha-tested so only its frame casts.
  const cutoutDepth = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: shared,
    vertexShader: /* glsl */ `
      in float material;
      out vec3 vPos;
      out vec3 vNormal;
      flat out int vMat;
      void main() {
        vPos = position;
        vNormal = normal;
        vMat = int(material + 0.5);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${head}
      ${TRIPLANAR_GLSL}
      in vec3 vPos;
      in vec3 vNormal;
      flat in int vMat;
      layout(location = 0) out vec4 outColor;
      void main() {
        if (triplanar(vPos, normalize(vNormal), vMat).a < 0.5) discard;
        outColor = vec4(1.0);
      }
    `,
    ...DEPTH_PARAMS,
  });
  const shadowMaterials = [new THREE.MeshBasicMaterial(DEPTH_PARAMS), cutoutDepth, HIDDEN];

  return { materials, shadowMaterials };
}
