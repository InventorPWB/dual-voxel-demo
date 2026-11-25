import * as THREE from 'three';

const MAX = 600;
const GRAVITY = 9.8;

/**
 * Splashes: drops thrown up where something hits water (the player falling
 * in). Cosmetic only: points that fly, fall and fade.
 */
export class Splashes {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX); // seconds left; 0 = unused
    this.alpha = new Float32Array(MAX);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(90.0 / -mv.z, 1.5, 24.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = dot(q, q);
          if (d > 0.25) discard;
          gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), vAlpha * (1.0 - d * 4.0) * 0.8);
        }
      `,
    }));
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.live = 0;
    scene.add(this.points);
  }

  /** A splash at (x, y, z) metres, `size` about 0.3 (a drip) to 1.5 (a cannonball). */
  burst(x, y, z, size = 1) {
    const n = Math.round(30 + 90 * size);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.5 * size;
      this.pos[i * 3] = x + Math.cos(a) * r;
      this.pos[i * 3 + 1] = y + 0.02;
      this.pos[i * 3 + 2] = z + Math.sin(a) * r;
      const out = (0.6 + Math.random() * 1.6) * size;
      this.vel[i * 3] = Math.cos(a) * out;
      this.vel[i * 3 + 1] = (2 + Math.random() * 3.5) * size;
      this.vel[i * 3 + 2] = Math.sin(a) * out;
      this.life[i] = 0.5 + Math.random() * 0.6;
    }
    this.live = 1;
  }

  update(dt) {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      any = 1;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= GRAVITY * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = Math.min(1, this.life[i] * 3);
    }
    this.live = any;
    this.points.visible = !!any;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.alpha.needsUpdate = true;
  }
}
