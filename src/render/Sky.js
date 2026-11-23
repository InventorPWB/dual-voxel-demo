import * as THREE from 'three';
import { SKY_GLSL, lightingUniforms } from './lighting.js';

/**
 * The sky for shader lighting: a dome that follows the camera, drawn first
 * and behind everything. The same sky light as the lighting and fog use
 * (lighting.js: deep blue overhead, hazy at the horizon, a glow round the
 * sun), plus the sun's disc and a layer of drifting clouds, lit from the
 * sun's side, darker underneath where they're thick, glowing round the sun.
 * Linear HDR, like everything drawn with shader lighting: the sun's disc is
 * far brighter than white, so bloom spreads it.
 */
export function createSky(shadow) {
  const { uSunDir, uTime } = lightingUniforms(shadow);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uSunDir, uTime, uClouds: { value: 1 } },
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = position;
        // Rotation only (the dome is always round the eye), at the far plane.
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
        gl_Position.z = p.w * 0.99999;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uClouds;
      in vec3 vDir;
      layout(location = 0) out vec4 outColor;
      ${SKY_GLSL}

      float hash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) {
          s += a * noise(p);
          p = p * 2.03 + vec2(17.1, 9.2);
          a *= 0.5;
        }
        return s;
      }
      // Cloud density at a point on the cloud layer.
      float cloud(vec2 p) {
        float d = fbm(p);
        // Larger patches of clear sky between cloud banks.
        d *= smoothstep(0.25, 0.65, fbm(p * 0.23 + 41.0));
        return smoothstep(0.36, 0.66, d);
      }

      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyRadiance(d);
        vec3 S = sunLight();
        float mu = dot(d, uSunDir);
        float cover = 0.0;
        if (d.y > 0.0 && uClouds > 0.5) {
          // Where the view ray meets a flat cloud layer, drifting with the wind.
          vec2 p = d.xz / (d.y + 0.1) * 1.4 + vec2(uTime * 0.006, uTime * 0.0025);
          cover = cloud(p);
          if (cover > 0.0) {
            // Thicker towards the sun: that side is in the cloud's own shadow.
            float towards = cloud(p + uSunDir.xz * 0.12);
            float lit = clamp(1.0 - (towards - cover) * 1.6 - cover * 0.35, 0.25, 1.0);
            vec3 base = skyRadiance(vec3(0.0, 1.0, 0.0)) * 0.9 + vec3(0.12);
            vec3 col = base * (0.55 + 0.45 * lit) + S * lit * (0.22 + 0.6 * pow(max(mu, 0.0), 8.0));
            float fade = smoothstep(0.0, 0.18, d.y);
            cover *= fade;
            c = mix(c, col, cover * 0.95);
          }
        }
        // The sun's disc (about a degree across), hidden by thick cloud.
        float disc = smoothstep(0.99989, 0.99995, mu);
        c += S * disc * 12.0 * (1.0 - cover);
        outColor = vec4(c, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  /** Settings: clouds on or off. */
  mesh.setClouds = (on) => { material.uniforms.uClouds.value = on ? 1 : 0; };
  return mesh;
}
