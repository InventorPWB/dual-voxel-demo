import * as THREE from 'three';

/**
 * Lighting shared by every world material (terrain, pieces, glass, foliage),
 * so they all sit in the same light. Two models:
 *
 *  - classic: wrap-Lambert sun with real-time shadows from a SunShadow,
 *    hemisphere ambient, baked AO and flat fog, all in display (sRGB) values
 *    straight to the screen.
 *  - shader lighting (`HDR` define, see setShaderLighting): what game "shader
 *    packs" do. Lighting is computed in linear, high-dynamic-range values: a
 *    strong warm sun against a much dimmer blue sky light, so sunlit and
 *    shaded surfaces differ as they do outdoors; physically based materials
 *    (GGX highlights, and the sky reflected off every surface by its
 *    roughness and Fresnel); light through leaves; and aerial-perspective
 *    fog that takes the colour of the sky behind it. PostFX then adds
 *    ambient occlusion, sun shafts and bloom and maps the result to the
 *    screen with a filmic tone curve.
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
    // Settings: reflections (shader lighting) on/off, normal maps' strength.
    uSpecularScale: { value: 1 },
    uNormalStrength: { value: 1 },
  };
  return uniforms;
}

// ---- which model -------------------------------------------------------------

const litMaterials = new Set();
let hdr = false;

/** Whether shader lighting is on. */
export const shaderLighting = () => hdr;

/** Register a world material: it gets the `HDR` define while shader lighting is on. */
export function litMaterial(material) {
  material.defines = material.defines || {};
  litMaterials.add(material);
  applyMode(material);
  return material;
}

function applyMode(m) {
  if (hdr) m.defines.HDR = '';
  else delete m.defines.HDR;
  m.needsUpdate = true;
}

/** Switch every registered material between the two models (they recompile). */
export function setShaderLighting(on) {
  if (hdr === !!on) return;
  hdr = !!on;
  for (const m of litMaterials) applyMode(m);
}

/**
 * The sun and the sky (linear HDR), for shader lighting and the sky dome.
 * Expects `uniform vec3 uSunDir` declared before it.
 */
export const SKY_GLSL = /* glsl */ `
  // Sunlight reaching the ground (irradiance on a surface facing the sun):
  // warmer and dimmer as the sun sinks, through more air.
  vec3 sunLight() {
    float e = clamp(uSunDir.y, 0.0, 1.0);
    vec3 low = vec3(1.0, 0.52, 0.26), high = vec3(1.0, 0.9, 0.78);
    return mix(low, high, smoothstep(0.02, 0.45, e)) * (2.9 * smoothstep(-0.05, 0.12, uSunDir.y));
  }

  // The sky's light coming from direction d, without the sun's disc or the
  // clouds: deep blue overhead, pale and hazy at the horizon, brightest
  // round the sun (light scattered forward by the haze), a dimmer haze
  // below the horizon (the distant ground, seen through the air).
  vec3 skyRadiance(vec3 d) {
    float y = d.y;
    vec3 zenith = vec3(0.13, 0.30, 0.78), horizon = vec3(0.60, 0.72, 0.90);
    vec3 c = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.45));
    c = mix(c, horizon * vec3(0.78, 0.8, 0.82), 1.0 - smoothstep(-0.3, 0.0, y));
    float mu = max(dot(d, uSunDir), 0.0);
    vec3 s = sunLight();
    c += s * (0.03 * pow(mu, 6.0) + 0.05 * pow(mu, 60.0) + 0.25 * pow(mu, 600.0));
    // Dimmer when the sun is low.
    return c * (0.35 + 0.75 * smoothstep(-0.1, 0.5, uSunDir.y));
  }
`;

/** Fragment-shader declarations and functions. */
export const LIGHTING_GLSL = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSpecularScale;
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

  #ifndef HDR
  // ---- classic ------------------------------------------------------------

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
  // (specular is for shader lighting; ignored here.)
  vec3 shadeSurface(vec3 albedo, vec3 wpos, vec3 gn, vec3 n, float ao, float wrap, float rough, float specular) {
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

  vec3 fog(vec3 color, float depth, vec3 wpos) {
    float f = 1.0 - exp(-pow(depth * uFogDensity, 2.0));
    return mix(color, uFogColor, f);
  }

  #else
  // ---- shader lighting (linear HDR) ------------------------------------------
  ${SKY_GLSL}

  const float PI = 3.14159265;

  // Textures hold display (sRGB) values; lighting needs linear ones.
  vec3 toLinear(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(2.2));
  }

  // Light from the whole sky on a surface facing n (diffuse irradiance
  // over π), plus light bounced up off the sunlit ground.
  vec3 skyAmbient(vec3 n) {
    vec3 up = vec3(0.36, 0.43, 0.55) * 1.0;
    vec3 down = vec3(0.27, 0.24, 0.18) * 0.5 * clamp(uSunDir.y * 2.0, 0.0, 1.0);
    return mix(down, up, n.y * 0.5 + 0.5) * (0.35 + 0.65 * smoothstep(-0.1, 0.4, uSunDir.y));
  }

  // The baked corner occlusion, made stronger: it shades the sky light,
  // which in a crevice mostly can't get in.
  float skyOcclusion(float ao) {
    return pow(ao, 1.7);
  }

  // Lit colour of a surface (no normal map: foliage, glass). wrap: how far
  // light wraps past the terminator; backlit: sun shining through from
  // behind (leaves), tinted by the leaf.
  vec3 shade(vec3 albedo, vec3 wpos, vec3 n, float ao, float wrap, float backlit) {
    vec3 a = toLinear(albedo);
    float ndl = dot(n, uSunDir);
    float sun = clamp(ndl * (1.0 - wrap) + wrap, 0.0, 1.0);
    float facing = smoothstep(0.05 - wrap, 0.25, ndl);
    float vis = facing > 0.0 || backlit > 0.0 ? sunShadow(wpos, n, ndl) : 0.0;
    float lit = min(facing, vis);
    vec3 S = sunLight();
    vec3 color = a * (skyAmbient(n) * skyOcclusion(ao) + S * sun * lit);
    if (backlit > 0.0) {
      // Light through the leaf: most when looking towards the sun through it.
      vec3 v = normalize(cameraPosition - wpos);
      float through = 0.25 * clamp(-ndl, 0.0, 1.0) + 0.9 * pow(clamp(dot(-v, uSunDir), 0.0, 1.0), 4.0);
      color += a * S * (backlit * vis * through);
    }
    return color;
  }

  // Split-sum environment BRDF, analytic fit (Karis): how much of the
  // reflected environment a dielectric returns, by roughness and angle.
  vec2 envBRDF(float rough, float nv) {
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = rough * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
    return vec2(-1.04, 1.04) * a004 + r.zw;
  }

  // Lit colour of a physically based surface: albedo, roughness, a bumped
  // shading normal n and the geometric normal gn (for shadow lookups and the
  // terminator, so bumps don't cast acne). Diffuse sun and sky light, the
  // sun's highlight (GGX with height-correlated Smith visibility, 4%
  // reflectance head-on), and the sky reflected by roughness and Fresnel.
  // specular (0..1) scales all reflection: surfaces like grass and loose
  // soil hide most of theirs in their own gaps (a "specular level", as in
  // most engines), which a texel-scale roughness can't express.
  vec3 shadeSurface(vec3 albedo, vec3 wpos, vec3 gn, vec3 n, float ao, float wrap, float rough, float specular) {
    vec3 a = toLinear(albedo);
    specular *= uSpecularScale;
    float gndl = dot(gn, uSunDir);
    float ndl = dot(n, uSunDir);
    float facing = smoothstep(0.05 - wrap, 0.25, gndl);
    float vis = facing > 0.0 ? sunShadow(wpos, gn, gndl) : 0.0;
    float lit = min(facing, vis);
    vec3 S = sunLight();
    float occ = skyOcclusion(ao);

    vec3 v = normalize(cameraPosition - wpos);
    vec3 h = normalize(v + uSunDir);
    float nl = max(ndl, 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    rough = clamp(rough, 0.04, 1.0);
    float r2 = rough * rough, a2 = r2 * r2;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * d * d);
    float V = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
    float F = (0.04 + 0.96 * pow(1.0 - vh, 5.0)) * specular;

    float sun = clamp(ndl * (1.0 - wrap) + wrap, 0.0, 1.0);
    vec3 diffuse = a * (skyAmbient(n) * occ + S * sun * lit);
    // (S is irradiance over π, as in the diffuse term.)
    vec3 highlight = S * (PI * D * V * F * nl * lit);

    // The sky in the mirror direction, blurred towards the plain sky light
    // as the surface gets rougher; none from below the surface's horizon.
    vec3 r = reflect(-v, n);
    vec3 env = mix(skyRadiance(r), skyAmbient(n) * 1.3, r2);
    float horizon = clamp(1.0 + dot(r, gn), 0.0, 1.0);
    vec2 ab = envBRDF(rough, nv);
    vec3 reflection = env * (0.04 * ab.x + ab.y) * occ * horizon * horizon * specular;
    return diffuse + highlight + reflection;
  }

  // Aerial perspective: distance fades towards the colour of the sky behind,
  // near the horizon (warmer towards the sun).
  vec3 fog(vec3 color, float depth, vec3 wpos) {
    vec3 d = normalize(wpos - cameraPosition);
    vec3 haze = skyRadiance(normalize(vec3(d.x, max(d.y, 0.0) * 0.3 + 0.04, d.z)));
    float f = 1.0 - exp(-pow(depth * uFogDensity * 0.9, 1.5));
    return mix(color, haze, f);
  }
  #endif

  // Cutouts (glass, grass, leaves) are plain alpha tests: a pixel is either
  // fully drawn or not. Not alpha-to-coverage: on many drivers (NVIDIA and
  // D3D, which Chrome uses on Windows) it dithers partial coverage, which
  // shows up as dots of whatever is behind, often sky, all over foliage.
  // The hand-made mipmaps (textureArray.js) keep distant foliage full.
  bool cutout(float a) {
    return a < 0.5;
  }
`;
