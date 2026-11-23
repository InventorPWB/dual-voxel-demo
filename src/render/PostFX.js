import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SKY_GLSL } from './lighting.js';

/**
 * Post-processing for shader lighting. The scene is drawn into a
 * multisampled half-float (HDR) target with a depth texture, then:
 *
 *  1. ambient occlusion (SSAO), at half resolution from depth alone (normals
 *     rebuilt from the depth), so cutouts (grass, leaves) count exactly as
 *     drawn: darkens creases, the feet of walls and grass, under trees;
 *     blurred, sparing edges where depth jumps;
 *  2. sun shafts, at half resolution: sky pixels near the sun, smeared
 *     towards it on screen, so leaves and ridges in front of the sun cast
 *     rays through the haze;
 *  3. composite: occlusion and shafts applied, a contrast curve, a soft
 *     vignette;
 *  4. bloom on whatever is brighter than white (the sun, glints);
 *  5. tone mapping (Khronos PBR Neutral) and sRGB output to the screen.
 */
export class PostFX {
  constructor(renderer, sunDir) {
    this.renderer = renderer;
    this.sunDir = sunDir;
    const depth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth });
    const half = { type: THREE.HalfFloatType, depthBuffer: false };
    this.ao = new THREE.WebGLRenderTarget(1, 1, half);
    this.aoBlur = new THREE.WebGLRenderTarget(1, 1, half);
    this.rays = new THREE.WebGLRenderTarget(1, 1, half);
    this.lit = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });

    const common = { uDepth: { value: depth }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() } };
    this.common = common;
    this.aoPass = new FullScreenQuad(new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...common, uKernel: { value: kernel(16) } }, vertexShader: VERT, fragmentShader: AO_FRAG }));
    this.blurPass = new FullScreenQuad(new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...common, uAO: { value: this.ao.texture } }, vertexShader: VERT, fragmentShader: BLUR_FRAG }));
    this.raysPass = new FullScreenQuad(new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...common, uSun: { value: new THREE.Vector3() }, uSunDir: { value: sunDir }, uCamDir: { value: new THREE.Vector3() } },
      vertexShader: VERT, fragmentShader: RAYS_FRAG,
    }));
    this.compositePass = new FullScreenQuad(new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...common, uColor: { value: this.scene.texture }, uAO: { value: this.aoBlur.texture }, uRays: { value: this.rays.texture }, uSunDir: { value: sunDir },
        uAOStrength: { value: 0.85 }, uRaysStrength: { value: 0.3 }, uSaturation: { value: 1 }, uVignette: { value: 0.28 },
      },
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
    }));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.4);
    this.output = new OutputPass();
    this.output.renderToScreen = true;
    // Khronos "PBR Neutral": keeps the textures' own hues and saturation
    // (ACES bleaches sunlit colour towards white); the composite adds the
    // contrast.
    this.exposure = 0.85;
    this.toneMapping = THREE.NeutralToneMapping;
    this.effects = { ao: true, rays: true, bloom: true };
    this.brightness = 1;
    this.sunClip = new THREE.Vector4();
    this.camDir = new THREE.Vector3();
  }

  /**
   * Grade for the textures in use: the pixel art's palette was made for
   * flat lighting and is far more saturated than real surfaces, so it's
   * taken down a little.
   */
  setGrade({ exposure, saturation }) {
    this.exposure = exposure;
    this.compositePass.material.uniforms.uSaturation.value = saturation;
  }

  /**
   * Settings: which effects run ({ ao, rays, bloom, vignette }, booleans)
   * and `brightness`, a factor on the exposure. Effects that are off are
   * skipped, not just hidden.
   */
  setEffects({ ao, rays, bloom, vignette, brightness }) {
    this.effects = { ao, rays, bloom };
    this.brightness = brightness;
    const u = this.compositePass.material.uniforms;
    u.uAOStrength.value = ao ? 0.85 : 0;
    u.uRaysStrength.value = rays ? 0.3 : 0;
    u.uVignette.value = vignette ? 0.28 : 0;
  }

  setSize(width, height) {
    const pr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.round(width * pr)), h = Math.max(1, Math.round(height * pr));
    this.scene.setSize(w, h);
    this.lit.setSize(w, h);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.ao.setSize(hw, hh);
    this.aoBlur.setSize(hw, hh);
    this.rays.setSize(hw, hh);
    this.common.uTexel.value.set(1 / hw, 1 / hh);
    this.bloom.setSize(w, h);
  }

  /** Draw `scene` from `camera` through the whole chain to the screen. */
  render(scene, camera) {
    const r = this.renderer;
    this.common.uProj.value.copy(camera.projectionMatrix);
    this.common.uInvProj.value.copy(camera.projectionMatrixInverse);
    // Where the sun is on screen (uv), and whether it's in front.
    const s = this.sunClip.set(this.sunDir.x, this.sunDir.y, this.sunDir.z, 0).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    const sun = this.raysPass.material.uniforms.uSun.value;
    sun.set(s.x / s.w * 0.5 + 0.5, s.y / s.w * 0.5 + 0.5, s.w > 0 ? 1 : 0);
    camera.getWorldDirection(this.raysPass.material.uniforms.uCamDir.value);

    const fx = this.effects;
    r.setRenderTarget(this.scene);
    r.render(scene, camera);
    if (fx.ao) {
      r.setRenderTarget(this.ao);
      this.aoPass.render(r);
      r.setRenderTarget(this.aoBlur);
      this.blurPass.render(r);
    }
    if (fx.rays) {
      r.setRenderTarget(this.rays);
      this.raysPass.render(r);
    }
    r.setRenderTarget(this.lit);
    this.compositePass.render(r);
    if (fx.bloom) this.bloom.render(r, null, this.lit, 0, false);
    const tm = r.toneMapping, exposure = r.toneMappingExposure;
    r.toneMapping = this.toneMapping;
    r.toneMappingExposure = this.exposure * this.brightness;
    this.output.render(r, null, this.lit);
    r.toneMapping = tm;
    r.toneMappingExposure = exposure;
  }
}

/** `n` directions in the unit hemisphere (+z), more of them close in. */
function kernel(n) {
  const out = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 0.9 + 0.1).normalize();
    const t = (i + 1) / n;
    v.multiplyScalar(0.15 + 0.85 * t * t);
    out.push(v);
  }
  return out;
}

const VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const DEPTH_GLSL = /* glsl */ `
  uniform highp sampler2D uDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform vec2 uTexel;
  vec3 viewPos(vec2 uv) {
    float d = texture(uDepth, uv).r;
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
`;

const AO_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform vec3 uKernel[16];
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }
  void main() {
    float d = texture(uDepth, vUv).r;
    if (d >= 1.0) { outColor = vec4(1.0); return; }
    vec3 p = viewPos(vUv);
    // Normal from the neighbours, from whichever side is nearer in depth
    // (so silhouette edges don't bend it).
    vec3 l = viewPos(vUv - vec2(uTexel.x, 0.0)), rr = viewPos(vUv + vec2(uTexel.x, 0.0));
    vec3 b = viewPos(vUv - vec2(0.0, uTexel.y)), t = viewPos(vUv + vec2(0.0, uTexel.y));
    vec3 dx = abs(rr.z - p.z) < abs(p.z - l.z) ? rr - p : p - l;
    vec3 dy = abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b;
    vec3 n = normalize(cross(dx, dy));
    if (dot(n, p) > 0.0) n = -n;
    // A frame round it, turned at random per pixel.
    float a = hash(gl_FragCoord.xy) * 6.2831853;
    vec3 rnd = vec3(cos(a), sin(a), 0.0);
    vec3 tan = normalize(rnd - n * dot(rnd, n));
    mat3 tbn = mat3(tan, cross(n, tan), n);
    // Radius: half a metre, wider far away (so distant hills keep some).
    float radius = 0.5 + 0.004 * -p.z;
    float occ = 0.0;
    for (int i = 0; i < 16; i++) {
      vec3 s = p + tbn * uKernel[i] * radius;
      vec4 c = uProj * vec4(s, 1.0);
      vec2 suv = c.xy / c.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
      float sz = viewPos(suv).z;
      // Occluded if the scene there is in front of the sample, but not so
      // far in front that it's something else entirely.
      float range = smoothstep(0.0, 1.0, radius / abs(p.z - sz));
      occ += (sz >= s.z + 0.03 ? 1.0 : 0.0) * range;
    }
    float ao = 1.0 - occ / 16.0;
    outColor = vec4(vec3(ao), 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform sampler2D uAO;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  void main() {
    float z = viewPos(vUv).z;
    float sum = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        vec2 uv = vUv + vec2(x, y) * uTexel;
        float w = exp(-abs(viewPos(uv).z - z) * 4.0 / max(1.0, -z * 0.1));
        sum += texture(uAO, uv).r * w;
        wsum += w;
      }
    outColor = vec4(vec3(sum / wsum), 1.0);
  }
`;

const RAYS_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform vec3 uSun; // screen uv of the sun, and 1 if in front
  uniform vec3 uSunDir;
  uniform vec3 uCamDir;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  void main() {
    if (uSun.z < 0.5) { outColor = vec4(0.0); return; }
    // March from this pixel towards the sun, adding up the open sky passed
    // over (weighted to the sky right round the sun).
    vec2 delta = (uSun.xy - vUv) / 40.0;
    vec2 uv = vUv + delta * hash(gl_FragCoord.xy);
    float sum = 0.0, decay = 1.0;
    float aspect = uTexel.y / uTexel.x;
    for (int i = 0; i < 40; i++) {
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float sky = texture(uDepth, uv).r >= 1.0 ? 1.0 : 0.0;
      vec2 off = (uv - uSun.xy) * vec2(1.0, aspect);
      sum += sky * exp(-dot(off, off) * 90.0) * decay;
      decay *= 0.965;
      uv += delta;
    }
    // Strongest looking towards the sun.
    float facing = pow(max(dot(uCamDir, uSunDir), 0.0), 3.0);
    outColor = vec4(vec3(sum / 40.0 * facing), 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform sampler2D uColor;
  uniform sampler2D uAO;
  uniform sampler2D uRays;
  uniform vec3 uSunDir;
  uniform float uAOStrength;
  uniform float uRaysStrength;
  uniform float uSaturation;
  uniform float uVignette;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  ${SKY_GLSL}
  void main() {
    vec3 c = texture(uColor, vUv).rgb;
    float ao = texture(uAO, vUv).r;
    c *= mix(1.0, ao, uAOStrength);
    c += sunLight() * texture(uRays, vUv).r * uRaysStrength;
    // Contrast: a curve about mid-grey, in proportion (so hues hold).
    float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
    c *= pow(l / 0.18, 0.12);
    c = max(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSaturation), 0.0);
    // A soft vignette.
    vec2 q = vUv - 0.5;
    c *= 1.0 - uVignette * dot(q, q) * 2.0;
    outColor = vec4(c, 1.0);
  }
`;
