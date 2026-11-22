import * as THREE from 'three';

/**
 * Lighting shared by every world material (terrain, pieces, glass, foliage),
 * so they all sit in the same light: wrap-Lambert sun with real-time shadows
 * from a SunShadow, hemisphere ambient, baked AO and fog.
 */

export const SKY_COLOR = 0xa9cdee;

/** Direction towards the sun at the start (azimuth and elevation in radians). */
export const SUN_AZIMUTH = Math.atan2(0.35, 0.45);
export const SUN_ELEVATION = 0.95;

export function sunDirection(azimuth, elevation = SUN_ELEVATION, out = new THREE.Vector3()) {
  const c = Math.cos(elevation);
  return out.set(Math.cos(azimuth) * c, Math.sin(elevation), Math.sin(azimuth) * c);
}

const raw = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

let uniforms = null;

/** The shared uniform objects (the same objects in every material, so one update reaches all). */
export function lightingUniforms(shadow) {
  if (uniforms) return uniforms;
  uniforms = {
    uSunDir: { value: shadow.direction },
    uShadowMap: { value: shadow.texture },
    uShadowMatrix: { value: shadow.matrix },
    uShadowTexel: { value: shadow.texel }, // (uv per texel, metres per texel)
    uSunColor: { value: raw(0xfff1d6) },
    uSkyColor: { value: raw(0xc4dcf5) },
    uGroundColor: { value: raw(0x6b5a48) },
    uFogColor: { value: raw(SKY_COLOR) },
    uFogDensity: { value: 0.0085 },
    uTime: { value: 0 },
  };
  return uniforms;
}

/** Fragment-shader declarations and functions. Expects `vPos` (world position, metres). */
export const LIGHTING_GLSL = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform highp sampler2DShadow uShadowMap;
  uniform mat4 uShadowMatrix;
  uniform vec2 uShadowTexel;

  // Sun visibility: 0 = fully shadowed, 1 = lit.
  float sunShadow(vec3 wpos, vec3 n, float ndl) {
    // Normal offset, larger on grazing surfaces, keeps a surface from
    // shadowing itself (acne) without detaching shadows from their casters.
    float slope = 1.0 - clamp(ndl, 0.0, 1.0);
    vec3 wp = wpos + n * uShadowTexel.y * (1.0 + 2.5 * slope);
    vec3 sc = (uShadowMatrix * vec4(wp, 1.0)).xyz;
    if (sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 || sc.z >= 1.0) return 1.0;
    sc.z -= 0.0002;
    // 3×3 taps of hardware 2×2 PCF: a smooth 4×4 tent, soft but still crisp at contact.
    float s = 0.0;
    float d = uShadowTexel.x;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++)
        s += texture(uShadowMap, vec3(sc.xy + vec2(x, y) * d, sc.z));
    return s / 9.0;
  }

  // Lit colour of a surface. wrap: how far light wraps past the terminator
  // (0.2 for solid ground, more for foliage); backlit: sun shining through
  // from behind (leaves).
  vec3 shade(vec3 albedo, vec3 wpos, vec3 n, float ao, float wrap, float backlit) {
    float ndl = dot(n, uSunDir);
    float sun = clamp(ndl * (1.0 - wrap) + wrap, 0.0, 1.0);
    // Faces turned away from the sun are in their own shadow, so the wrap
    // light fades out towards the terminator instead of meeting a hard
    // shadow edge there. Only look the map up where it can matter.
    float facing = smoothstep(0.05 - wrap, 0.25, ndl);
    float vis = facing > 0.0 || backlit > 0.0 ? sunShadow(wpos, n, ndl) : 0.0;
    float lit = min(facing, vis);
    vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
    // Shadowed areas keep a little cool sky fill so they read as shade, not as holes.
    vec3 light = hemi * 0.62 + uSunColor * sun * lit * 0.72 + uSkyColor * (1.0 - lit) * sun * 0.06;
    light += uSunColor * backlit * vis * clamp(-ndl, 0.0, 1.0) * 0.35;
    return albedo * light * ao;
  }

  vec3 fog(vec3 color, float depth) {
    float f = 1.0 - exp(-pow(depth * uFogDensity, 2.0));
    return mix(color, uFogColor, f);
  }

  // Alpha-to-coverage: sharpen a texture's alpha to a crisp edge about one pixel wide.
  float cutoutAlpha(float a) {
    return clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  }
`;
