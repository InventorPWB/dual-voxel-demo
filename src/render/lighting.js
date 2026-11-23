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

  // Lit colour of a surface with a normal map and roughness. gn is the
  // geometric normal (shadow lookups and the terminator, so bumps don't cast
  // acne), n the bumped shading normal. Adds the sun's highlight (GGX, a
  // dielectric: 4% reflectance head-on) and a sheen of sky at grazing angles.
  vec3 shadeSurface(vec3 albedo, vec3 wpos, vec3 gn, vec3 n, float ao, float wrap, float rough) {
    float gndl = dot(gn, uSunDir);
    float ndl = dot(n, uSunDir);
    float sun = clamp(ndl * (1.0 - wrap) + wrap, 0.0, 1.0);
    float facing = smoothstep(0.05 - wrap, 0.25, gndl);
    float vis = facing > 0.0 ? sunShadow(wpos, gn, gndl) : 0.0;
    float lit = min(facing, vis);
    vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
    vec3 light = hemi * 0.62 + uSunColor * sun * lit * 0.72 + uSkyColor * (1.0 - lit) * sun * 0.06;
    vec3 color = albedo * light * ao;

    vec3 v = normalize(cameraPosition - wpos);
    vec3 h = normalize(v + uSunDir);
    float nl = max(ndl, 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    float a = max(rough * rough, 0.003), a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * d * d);
    // Height-correlated Smith visibility.
    float V = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
    float F = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    // The diffuse term above is albedo × 0.72 × sun, i.e. irradiance 0.72π.
    color += uSunColor * (D * V * F * nl * lit * 0.72 * 3.14159265);
    float Fv = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    color += uSkyColor * Fv * (1.0 - rough) * (1.0 - rough) * 0.35 * ao;
    return color;
  }

  vec3 fog(vec3 color, float depth) {
    float f = 1.0 - exp(-pow(depth * uFogDensity, 2.0));
    return mix(color, uFogColor, f);
  }

  // Cutouts (glass, grass, leaves) are plain alpha tests: a pixel is either
  // fully drawn or not. Not alpha-to-coverage: on many drivers (NVIDIA and
  // D3D, which Chrome uses on Windows) it dithers partial coverage, which
  // shows up as dots of whatever is behind, often sky, all over foliage.
  // The hand-made mipmaps (textureArray.js) keep distant foliage full.
  bool cutout(float a) {
    return a < 0.5;
  }
`;
