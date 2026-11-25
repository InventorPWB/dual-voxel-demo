import * as THREE from 'three';
import { LIGHTING_GLSL, lightingUniforms, litMaterial } from './lighting.js';

/**
 * The water surface (spanMesh.js and the other water meshers). Drawn after
 * everything solid, blended, from both sides (from underwater you see its
 * underside).
 *
 *  - Small waves: gradient noise, its slope worked out exactly (no finite
 *    differences), carried along the mesh's `flow` (m/s): a river's surface
 *    visibly runs downstream, drawn out along the current the faster it goes,
 *    and still water only shimmers. See `waves`.
 *  - White water where water runs fast over a shallow bed (its Froude number:
 *    speed against the speed of waves at that depth), as a steep chute
 *    does; faint streaks of foam riding a brisk current; falling water white.
 *  - Reflection: the sky in the mirror direction (the sky dome's own function
 *    under shader lighting), by Fresnel, and the sun's glint (GGX).
 *  - Below the surface: with `REFRACT` (shader lighting, PostFX's water pass),
 *    the ground behind refracted, darkened where it's wet and absorbed by how
 *    much water the view crosses (Beer–Lambert), and the surface fades out
 *    over the last few centimetres of depth, so a shore is one clean, soft
 *    line wherever the ground meets the water. Without it, a tinted body
 *    colour, blended.
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
    // REFRACT: the camera's projection scale (x, y), to find what's behind a pixel.
    uProj: { value: new THREE.Vector2(1, 1) },
    // Without REFRACT: the mesh's depths (metres) over which the surface fades in.
    uFade: { value: new THREE.Vector2(0.08, 0.18) },
    // From the mesh's flow attribute to a speed (m/s): the cellular mesher's
    // is a surface slope, the others' the water's own speed.
    uFlowScale: { value: 18 },
    ...extra,
  };

  const vertexShader = /* glsl */ `
    uniform float uTime;
    in vec3 flow;
    in float depth;
    // Where this vertex was in the chunk's previous mesh (height), when this
    // mesh arrived and over how long to move from there (seconds), and the
    // flow (x, z) and depth shown there then: the surface, and how it runs,
    // glide between re-meshes instead of jumping (ChunkMeshes).
    in vec3 morph;
    in vec3 was;
    out float vWater;
    out vec3 vPos;
    out vec3 vNormal;
    out vec3 vFlow;
    out float vDepth;
    void main() {
      vec3 p = position;
      vFlow = flow;
      vWater = depth;
      if (morph.z > 0.0) {
        float k = clamp((uTime - morph.y) / morph.z, 0.0, 1.0);
        p.y = mix(morph.x, p.y, k);
        vFlow.xy = mix(was.xy, flow.xy, k);
        vWater = mix(was.z, depth, k);
      }
      vPos = p;
      vNormal = normal;
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
      uniform vec2 uProj;
      // The world point at screen position q (0..1) and linear depth d.
      vec3 worldAt(vec2 q, float d) {
        vec2 ndc = q * 2.0 - 1.0;
        return cameraPosition + transpose(mat3(viewMatrix)) * (vec3(ndc.x / uProj.x, ndc.y / uProj.y, -1.0) * d);
      }
    #endif
    in vec3 vPos;
    in vec3 vNormal;
    in vec3 vFlow;
    in float vDepth;
    in float vWater;
    layout(location = 0) out vec4 outColor;

    // Integer hash: as good a hundred metres from the origin as at it (a
    // float hash loses precision far out, and its pattern turns to lines).
    uint hashu(ivec2 q) {
      uvec2 u = uvec2(q) * uvec2(1597334673u, 3812015801u);
      uint n = (u.x ^ u.y) * 1597334673u;
      return n ^ (n >> 16);
    }
    vec2 hash2(ivec2 q) {
      uint n = hashu(q);
      return vec2(float(n & 65535u), float(n >> 16)) * (1.0 / 65535.0);
    }
    // Gradient noise (about -0.7..0.7) and its exact gradient: xy gradient, z value.
    vec3 noised(vec2 p) {
      vec2 fi = floor(p);
      ivec2 i = ivec2(fi);
      vec2 f = p - fi;
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
      vec2 ga = hash2(i) * 2.0 - 1.0;
      vec2 gb = hash2(i + ivec2(1, 0)) * 2.0 - 1.0;
      vec2 gc = hash2(i + ivec2(0, 1)) * 2.0 - 1.0;
      vec2 gd = hash2(i + ivec2(1, 1)) * 2.0 - 1.0;
      float va = dot(ga, f);
      float vb = dot(gb, f - vec2(1.0, 0.0));
      float vc = dot(gc, f - vec2(0.0, 1.0));
      float vd = dot(gd, f - vec2(1.0, 1.0));
      float k = va - vb - vc + vd;
      vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va);
      return vec3(g, va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k);
    }

    // Small waves at p (metres) on water running at flow (m/s): their slope
    // (xy: dh/dx, dh/dz) and a pattern (z, about -1..1) for foam to follow.
    // fw: the pixel's footprint (metres); finer detail is left out (it
    // would only shimmer).
    //
    // The plane is cut into tiles. Each draws the pattern turned to the
    // current and drawn out along it, anchored at its own centre (turned
    // about the world's origin instead, a slight bend in the current would
    // shear it into fine lines), and the four tiles round a point blend
    // smoothly. And it rides the current in two phases, each restarted
    // (with a fresh pattern) while the other shows, so it moves on for ever
    // without being stretched out of shape where the current speeds up.
    // Both blends keep the waves' strength the same throughout.
    const float TILE = 2.5;
    const float PERIOD = 1.7;
    vec3 waves(vec2 p, vec2 flow, float t, float fw) {
      // (A breath of wind, so still water isn't frozen.)
      flow += vec2(0.05, 0.035);
      float speed = length(flow);
      vec2 dir = flow / speed;
      vec2 side = vec2(-dir.y, dir.x);
      float stretch = 1.0 + 2.5 * smoothstep(0.2, 2.5, speed);
      vec2 g = p / TILE - 0.5;
      vec2 c = floor(g), fr = g - c;
      vec3 acc = vec3(0.0);
      float w2 = 0.0;
      for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        vec2 bw = mix(1.0 - fr, fr, vec2(o));
        float wt = bw.x * bw.y;
        if (wt < 0.002) continue;
        ivec2 tile = ivec2(c) + o;
        vec2 d = p - (vec2(tile) + 0.5) * TILE;
        vec2 q0 = vec2(dot(d, dir), dot(d, side));
        for (int ph = 0; ph < 2; ph++) {
          float cyc = t / PERIOD + 0.5 * float(ph);
          float phase = fract(cyc);
          float w = wt * (1.0 - abs(2.0 * phase - 1.0));
          if (w < 0.002) continue;
          vec2 q = vec2((q0.x - speed * phase * PERIOD) / stretch, q0.y);
          q += hash2(tile * 7 + ivec2(int(floor(cyc)) * 13, ph * 5)) * 64.0;
          vec3 s = vec3(0.0);
          float amp = 1.0, freq = 1.3;
          for (int n = 0; n < 3; n++) {
            float keep = 1.0 - smoothstep(0.2, 0.5, fw * freq);
            if (keep <= 0.0) break;
            vec3 h = noised(q * freq + float(n) * 31.7);
            s += vec3(h.xy * freq, h.z) * amp * keep;
            amp *= 0.45;
            freq *= 2.3;
          }
          acc += w * vec3(s.x * dir / stretch + s.y * side, s.z);
          w2 += w * w;
        }
      }
      return acc / sqrt(max(w2, 1e-6));
    }

    void main() {
      vec3 gn = normalize(vNormal);
      vec3 v = normalize(cameraPosition - vPos);
      bool below = !gl_FrontFacing;
      float t = uTime;
      vec2 flow = vFlow.xy * uFlowScale;
      float speed = length(flow);
      if (speed > 6.0) { flow *= 6.0 / speed; speed = 6.0; }
      // flow.z: 0 the surface; 1..2 falling water (1 leaving the lip, 2 at
      // the bottom: glassy as it goes over, white by the time it lands); 3 a
      // pane of still water against glass (SpanSim's).
      bool pane = vFlow.z > 2.5;
      float falling = !pane && vFlow.z > 0.5 ? 1.0 : 0.0;
      float down = falling * clamp(vFlow.z - 1.0, 0.0, 1.0);
      float fw = max(length(dFdx(vPos.xz)), length(dFdy(vPos.xz)));

      // White water: fast over a shallow bed (Froude number well over 1), or
      // running down anything steep.
      float froude = speed / sqrt(9.81 * max(vWater, 0.03));
      float steep = 1.0 - smoothstep(0.62, 0.9, abs(gn.y));
      float rough = max(smoothstep(1.3, 3.5, froude) * smoothstep(0.6, 1.5, speed), steep * smoothstep(0.1, 0.5, speed + falling));
      if (falling > 0.5) rough *= smoothstep(0.0, 0.45, down);

      // Shading normal: small waves on the level, and where it's steep (or
      // falling) streaks pouring down it, drawn on the two upright planes
      // (along x and along z) and blended by which way it faces, so they
      // never shear.
      vec3 n = gn;
      float pattern = 0.0;
      if (!pane) {
        float top = falling > 0.5 ? 0.0 : smoothstep(0.5, 0.8, abs(gn.y));
        vec2 slope = vec2(0.0);
        if (top > 0.0) {
          vec3 w = waves(vPos.xz, flow, t, fw);
          float strength = mix(0.05, 0.13, smoothstep(0.05, 1.2, speed)) + 0.12 * rough;
          slope = w.xy * strength * top;
          pattern = w.z * top;
        }
        vec3 side = vec3(0.0);
        if (top < 1.0) {
          float down = 2.2 + 1.5 * falling;
          float ax = abs(gn.x), az = abs(gn.z);
          float wx = ax / max(ax + az, 1e-4);
          vec2 qx = vec2(vPos.z * 3.5, vPos.y * 0.9 + t * down);
          vec2 qz = vec2(vPos.x * 3.5, vPos.y * 0.9 + t * down);
          vec3 hx = noised(qx) + noised(qx * vec2(2.1, 1.7) + 9.3) * 0.5;
          vec3 hz = noised(qz) + noised(qz * vec2(2.1, 1.7) + 9.3) * 0.5;
          vec3 h = mix(hz, hx, wx);
          pattern += h.z * (1.0 - top);
          vec3 across = cross(gn, vec3(0.0, 1.0, 0.0));
          across = dot(across, across) > 1e-6 ? normalize(across) : vec3(1.0, 0.0, 0.0);
          side = across * h.x * 0.25 * (1.0 - top);
        }
        // (Added to the sheet's own slope where it runs down one.)
        float gy = abs(gn.y);
        n = normalize(vec3(gn.x - slope.x * gy, gn.y, gn.z - slope.y * gy) + side);
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
      vec3 hv = normalize(v + uSunDir);
      float nh = max(dot(n, hv), 0.0), nl = max(dot(n, uSunDir), 0.0);
      float roughness = falling > 0.5 ? mix(0.06, 0.35, smoothstep(0.0, 0.4, down)) : mix(0.05, 0.22, rough);
      float a2 = roughness * roughness * roughness * roughness;
      float dd = nh * nh * (a2 - 1.0) + 1.0;
      float glint = a2 / (3.14159265 * dd * dd) * nl * vis * 0.25;

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

      // How white: falling water mostly; white water in streaks along the
      // current; and on a brisk current, faint lines of foam riding it (not
      // on a film of water running over the grass).
      float p01 = clamp(0.5 + pattern * 0.8, 0.0, 1.0);
      float white = falling > 0.5 ? mix(0.45, 0.85, smoothstep(0.3, 0.7, p01)) * smoothstep(0.0, 0.45, down) : 0.0;
      white = max(white, rough * mix(0.25, 0.8, smoothstep(0.35, 0.75, p01)));
      white = max(white, smoothstep(0.62, 0.82, p01) * smoothstep(0.15, 0.9, speed) * smoothstep(0.05, 0.15, vWater) * 0.22);
      if (below) white *= 0.3;
      vec3 body = mix(bodyColor, foamColor, white);

      #ifdef REFRACT
        vec2 uv = gl_FragCoord.xy / uScreen;
        float surf = vDepth;
        float behind0 = texture(uOpaqueDepth, uv).r;
        // What's behind, refracted by the waves (less through thin water),
        // and only if it's under this water: not something in front of it,
        // nor the bank above the waterline (which would streak down into it).
        vec2 ruv = uv + n.xz * 0.08 * clamp((behind0 - surf) * 0.5, 0.0, 1.0);
        float behind = texture(uOpaqueDepth, ruv).r;
        if (behind < surf || dot(worldAt(ruv, behind) - vPos, gn) > 0.0) { ruv = uv; behind = behind0; }
        vec3 scene = texture(uOpaque, ruv).rgb;
        // How far the view runs through water to reach it (metres), and how
        // deep the water is over it (across the sheet, so a sheet running
        // down a slope is as deep seen from below as from above).
        float ray = distance(worldAt(ruv, behind), vPos);
        float deep = max(dot(vPos - worldAt(uv, behind0), gn), 0.0);
        if (pane) { ray = max(ray, 4.0); deep = 1.0; }
        // The shore: the surface fades out over the last few centimetres of
        // depth (wider far off, where depth is coarser), so where the ground
        // meets the water is one soft, exact line.
        float edge = pane || below ? 1.0 : smoothstep(0.0, 0.025 + surf * 0.0015, deep);
        // Light crossing the water: red goes first, then green (Beer–Lambert, per metre).
        vec3 through = exp(-vec3(0.5, 0.11, 0.085) * ray * 2.0);
        // Ground under water is wet: darker.
        scene *= 0.78;
        // Light scattered back out of the water builds up with depth.
        float murk = 1.0 - exp(-ray * 0.7);
        vec3 transmitted = scene * through + bodyColor * murk;
        if (falling > 0.5) {
          // A falling sheet, laid over whatever's behind it (the pool it falls
          // into included): glassy as it leaves the lip (what's behind seen
          // through it, bent and tinted), white water further down.
          float solid = clamp(vWater, 0.0, 1.0);
          vec3 vn = normalize((viewMatrix * vec4(n, 0.0)).xyz);
          vec3 glass = texture(uOpaque, uv + vn.xy * 0.025).rgb * vec3(0.72, 0.86, 0.88) * 0.85;
          vec3 c = mix(glass * (1.0 - F) + reflection * F, foamColor, white);
          float a = solid * mix(0.7, 1.0, white);
          outColor = vec4(fog(c, vDepth, vPos) * a, a);
          return;
        }
        transmitted = mix(transmitted, foamColor, white);
        vec3 color = transmitted * (1.0 - F) + reflection * F;
        color = below ? color : fog(color, vDepth, vPos);
        // (Premultiplied: at the shore, what's already there shows through.)
        outColor = vec4(color * edge, edge);
      #else
        float fade = falling > 0.5 ? clamp(vWater, 0.0, 1.0) : smoothstep(uFade.x, uFade.y, vWater);
        float bodyAlpha = mix(0.6, 0.95, white);
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
