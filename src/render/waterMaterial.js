import * as THREE from 'three';
import { LIGHTING_GLSL, lightingUniforms, litMaterial } from './lighting.js';

/**
 * The water surface (src/mesh/fluidMesh.js). Drawn after everything solid,
 * blended, from both sides (from underwater you see its underside).
 *
 *  - Ripples: a height field of a few octaves of noise, finite-differenced
 *    into a normal. Moved along the mesh's `flow` (downhill along the
 *    surface) with the usual two-phase flow-map blend, so rivers visibly run
 *    and still water only shimmers. Falling water streams downwards.
 *  - Reflection: the sky in the mirror direction (the sky dome's own
 *    function under shader lighting), by Fresnel, and the sun's glint
 *    (GGX on a nearly smooth surface: bright enough to bloom).
 *  - Below the surface: a tinted, lit body colour, and see-through by how
 *    much isn't reflected. With `REFRACT` (shader lighting, PostFX's water
 *    pass), the ground behind is refracted and absorbed by how much water the
 *    light crosses, and the shallows foam; see PostFX.
 * Output is premultiplied (what shows through is scaled by 1 − alpha), so
 * reflection adds to the scene behind rather than covering it.
 */
export function createWaterMaterial(shadow, extra = {}) {
  const uniforms = {
    ...lightingUniforms(shadow),
    // REFRACT: the scene drawn so far and its linear depth (PostFX), and the screen size.
    uOpaque: { value: null },
    uOpaqueDepth: { value: null },
    uScreen: { value: new THREE.Vector2(1, 1) },
    // Depths (metres) over which the surface fades in: see fade in the shader.
    uFade: { value: new THREE.Vector2(0.08, 0.18) },
    // From the mesh's flow attribute to a speed (about m/s): the cellular mesher's
    // is a surface slope, the contoured one's the flux water's own flow.
    uFlowScale: { value: 18 },
    ...extra,
  };

  const vertexShader = /* glsl */ `
    uniform float uTime;
    in vec3 flow;
    in float depth;
    // Where this vertex was in the chunk's previous mesh (height), when this
    // mesh arrived and over how long to move from there (seconds): the
    // surface glides between re-meshes instead of jumping (ChunkMeshes).
    in vec3 morph;
    out float vWater;
    out vec3 vPos;
    out vec3 vNormal;
    out vec3 vFlow;
    out float vDepth;
    void main() {
      vec3 p = position;
      p.y = mix(morph.x, p.y, morph.z > 0.0 ? clamp((uTime - morph.y) / morph.z, 0.0, 1.0) : 1.0);
      vPos = p;
      vNormal = normal;
      vFlow = flow;
      vWater = depth;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;

  const fragmentShader = /* glsl */ `
    uniform float uTime;
    uniform vec2 uFade;
    uniform float uFlowScale;
    ${LIGHTING_GLSL}
    #ifdef REFRACT
      uniform sampler2D uOpaque;
      uniform sampler2D uOpaqueDepth;
      uniform vec2 uScreen;
    #endif
    in vec3 vPos;
    in vec3 vNormal;
    in vec3 vFlow;
    in float vDepth;
    in float vWater;
    layout(location = 0) out vec4 outColor;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    // Ripple height at p (metres), still water drifting slowly with time.
    float ripples(vec2 p, float t) {
      float h = vnoise(p * 0.9 + vec2(t * 0.11, t * 0.07)) * 0.55;
      h += vnoise(p * 2.3 + vec2(-t * 0.21, t * 0.17)) * 0.3;
      h += vnoise(p * 5.7 + vec2(t * 0.37, -t * 0.29)) * 0.15;
      return h;
    }
    vec2 rippleSlope(vec2 p, float t) {
      const float e = 0.04;
      float h = ripples(p, t);
      return vec2(ripples(p + vec2(e, 0.0), t) - h, ripples(p + vec2(0.0, e), t) - h) / e;
    }
    // Two phases of the pattern carried along the flow, each reset while the
    // other is shown, so it moves without stretching.
    vec2 flowSlope(vec2 p, vec2 flow, float t) {
      float ph0 = fract(t * 0.35), ph1 = fract(t * 0.35 + 0.5);
      float w = abs(ph0 - 0.5) * 2.0;
      vec2 a = rippleSlope(p - flow * ph0 * 1.6, t);
      vec2 b = rippleSlope(p - flow * ph1 * 1.6 + 0.37, t);
      return mix(a, b, w);
    }

    void main() {
      vec3 gn = normalize(vNormal);
      vec3 v = normalize(cameraPosition - vPos);
      bool below = !gl_FrontFacing;
      float t = uTime;
      // (The mesh's flow is the surface's slope, small even in a brisk river: scaled up to a speed.)
      vec2 flow = vFlow.xy * uFlowScale;
      float speed = length(flow);
      if (speed > 2.5) { flow *= 2.5 / speed; speed = 2.5; }
      // 1: falling water; 2: a pane of still water against glass (SpanSim's).
      bool pane = vFlow.z > 1.5;
      float falling = pane ? 0.0 : vFlow.z;
      bool wall = !pane && abs(gn.y) < 0.5;

      // Shading normal: ripples, stronger where it runs, streaks where it falls.
      vec3 n;
      if (pane) {
        n = gn;
      } else if (wall) {
        // Along the wall: streaks running down.
        vec3 side = normalize(cross(gn, vec3(0.0, 1.0, 0.0)));
        vec2 q = vec2(dot(vPos, side) * 3.0, vPos.y * 0.8 + t * 2.4);
        float s = vnoise(q) - vnoise(q + vec2(0.0, 0.15));
        n = normalize(gn + side * s * 0.6);
      } else {
        vec2 slope = flowSlope(vPos.xz, flow, t) * (0.035 + 0.05 * min(speed, 1.0));
        n = normalize(vec3(-slope.x, 1.0, -slope.y) * vec3(1.0, sign(gn.y), 1.0));
        n = normalize(n + vec3(gn.x, 0.0, gn.z));
      }
      if (below) { n = -n; gn = -gn; }

      float nv = max(dot(n, v), 0.0);
      // Water's Fresnel (n = 1.33): 2% head-on, all at grazing angles.
      float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
      // From below, past the critical angle the surface is a mirror (Snell's window).
      if (below) F = nv < 0.66 ? 1.0 : F;
      float ndl = dot(gn, uSunDir);
      float vis = ndl > 0.0 ? sunShadow(vPos, gn, ndl) : 0.0;
      vec3 r = reflect(-v, n);
      vec3 h = normalize(v + uSunDir);
      float nh = max(dot(n, h), 0.0), nl = max(dot(n, uSunDir), 0.0);
      float rough = wall || falling > 0.5 ? 0.35 : 0.06;
      float a2 = rough * rough * rough * rough;
      float d = nh * nh * (a2 - 1.0) + 1.0;
      float glint = a2 / (3.14159265 * d * d) * nl * vis * 0.25;

      #ifdef HDR
        vec3 sky = skyRadiance(r);
        vec3 S = sunLight();
        vec3 ambient = skyAmbient(vec3(0.0, 1.0, 0.0));
        // Light scattered back out of the water (deep blue-green), and of white water.
        vec3 bodyColor = vec3(0.012, 0.05, 0.06) * (ambient * 2.0 + S * max(uSunDir.y, 0.0) * 0.5);
        vec3 foamColor = (ambient + S * max(ndl, 0.0) * vis) * 0.7;
        if (below) sky = vec3(0.02, 0.08, 0.09) * (ambient + S * 0.3);
      #else
        vec3 sky = mix(uFogColor, uSkyColor * 0.85, clamp(r.y * 2.0, 0.0, 1.0));
        vec3 S = uSunColor;
        vec3 bodyColor = vec3(0.1, 0.27, 0.32) * (0.65 + 0.35 * max(uSunDir.y, 0.0));
        vec3 foamColor = vec3(0.85, 0.9, 0.92) * (0.6 + 0.4 * max(ndl, 0.0) * vis);
        if (below) sky = vec3(0.1, 0.25, 0.3);
      #endif
      vec3 reflection = sky + S * glint * uSpecularScale;

      // Falling water turns white; small cascades and fast water a little.
      float white = falling > 0.5 ? 0.2 : wall ? 0.15 : 0.0;
      // Fast water breaks into white streaks running downhill (rapids, a
      // shallow stream on a slope): a moving pattern, not a wash over it all.
      if (speed > 0.15 && !wall) {
        vec2 dir = flow / speed;
        vec2 q = vec2(dot(vPos.xz, vec2(-dir.y, dir.x)), dot(vPos.xz, dir));
        float st = vnoise(vec2(q.x * 5.0, q.y * 1.2 - t * 3.0 * speed)) * 0.6 + vnoise(vec2(q.x * 2.0 + 3.0, q.y * 0.6 - t * 2.0 * speed)) * 0.4;
        white = max(white, smoothstep(0.55, 0.8, st) * smoothstep(0.15, 0.7, speed) * 0.55);
      }
      // The surface fades in with depth, from 8 to 18 cm: shallower water is
      // drawn on the ground under it instead (waterFilm in waterHeight.js),
      // so the shallows, shores and little cascades follow the smooth ground
      // and nothing pops in or out cell by cell.
      float fade = smoothstep(uFade.x, uFade.y, vWater);
      vec3 body = mix(bodyColor, foamColor, white);
      float bodyAlpha = mix(0.62, 0.95, white);

      #ifdef REFRACT
        // What's behind, refracted by the ripples, and how much water it's seen through.
        vec2 uv = gl_FragCoord.xy / uScreen;
        float surf = vDepth;
        vec2 ruv = uv + n.xz * 0.04 * clamp((texture(uOpaqueDepth, uv).r - surf) * 0.5, 0.0, 1.0);
        float behind = texture(uOpaqueDepth, ruv).r;
        if (behind < surf) { ruv = uv; behind = texture(uOpaqueDepth, uv).r; }
        // (Running water is shaded as if at least 30 cm deep: a stream racing
        // down a slope is only a centimetre or two of water, but should still
        // read as the same stream, not vanish into the sand.)
        float thick = max(max(behind - surf, 0.0), 0.3 * smoothstep(0.1, 0.6, speed));
        // Through a window into water: what's behind is the glass, but the
        // view goes on through the water beyond it.
        if (pane) thick = max(thick, 4.0);
        // Light crossing the water: red goes first, then green (Beer–Lambert, per metre).
        vec3 through = exp(-vec3(0.45, 0.09, 0.07) * (thick + 0.25) * 1.6);
        vec3 scene = texture(uOpaque, ruv).rgb;
        // Scattered light builds up with depth; the ground fades into it
        // (a little even in the shallows, so they read as water).
        float murk = 0.1 + 0.9 * (1.0 - exp(-thick * 0.35));
        // Very thin water: the ground under it is wet (darker), and its
        // surface broken, so it hardly mirrors the sky.
        float thin = 1.0 - smoothstep(0.02, 0.15, thick);
        scene *= 1.0 - 0.25 * thin;
        // (Not running water: its broken surface catches the light all the more.)
        F *= 1.0 - 0.7 * thin * (1.0 - smoothstep(0.1, 0.6, speed));
        vec3 transmitted = scene * through + body * murk;
        // Foam where the water's thin, along the shore.
        // (Only in the last few centimetres at the water's edge, and faint: a
        // whole shallow sheet is thin, and foamed all over it turns milky.)
        float foam = (1.0 - smoothstep(0.005, 0.03, thick)) * smoothstep(0.45, 0.8, vnoise(vPos.xz * 5.0 + t * 0.4)) * (below ? 0.0 : 1.0);
        transmitted = mix(transmitted, foamColor, foam * 0.2 + white * 0.5);
        vec3 color = transmitted * (1.0 - F) + reflection * F;
        color = below ? color : fog(color, vDepth, vPos);
        outColor = vec4(mix(texture(uOpaque, uv).rgb, color, fade), 1.0);
      #else
        vec3 lit = below ? body : fog(body, vDepth, vPos);
        vec3 refl = below ? reflection : fog(reflection, vDepth, vPos);
        float a = bodyAlpha * (1.0 - F);
        outColor = vec4(lit * a + refl * F, a + F) * fade;
      #endif
    }
  `;

  const material = litMaterial(new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    // Wins ties with the ground it lies on (a thin sheet over the smooth
    // ground), rather than the two fighting over which shows, in bands.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  }));
  return material;
}

/** Turn refraction on or off (it needs PostFX's water pass to provide the scene behind). */
export function setWaterRefraction(material, on) {
  if (!!material.defines.REFRACT === !!on) return;
  if (on) material.defines.REFRACT = '';
  else delete material.defines.REFRACT;
  material.needsUpdate = true;
}
