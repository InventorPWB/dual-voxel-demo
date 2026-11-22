import * as THREE from 'three';
import { World, VOXEL } from './world/World.js';
import { generateWorld, surfaceHeight } from './world/generate.js';
import { createChunkMaterials, SKY_COLOR, SUN_AZIMUTH, sunDirection } from './render/terrainMaterial.js';
import { createFoliageMaterials } from './render/foliageMaterial.js';
import { lightingUniforms } from './render/lighting.js';
import { SunShadow } from './render/SunShadow.js';
import { ChunkMeshes } from './render/ChunkMeshes.js';
import { Player } from './player/Player.js';
import { Interaction } from './items/interaction.js';
import { defaultHotbar } from './items/items.js';
import { Hud, Hotbar } from './ui/hud.js';

// ---- scene ------------------------------------------------------------------

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COLOR);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---- world --------------------------------------------------------------------

const hotbar = new Hotbar(defaultHotbar());
const hud = new Hud(hotbar);
hud.setLoading('Generating terrain…');

const world = new World(8, 4, 8); // 128 × 64 × 128 m in 0.5 m voxels (16 m chunks)
const shadow = new SunShadow(renderer, scene);
let sunAzimuth = SUN_AZIMUTH;
shadow.setDirection(sunDirection(sunAzimuth));
const chunkMeshes = new ChunkMeshes(world, scene, createChunkMaterials(shadow), createFoliageMaterials(shadow));
const uTime = lightingUniforms(shadow).uTime;
chunkMeshes.onChange = () => { shadow.dirty = true; };
const player = new Player(world, camera, () => chunkMeshes.list);
const interaction = new Interaction({ world, scene, camera, chunkMeshes, player, hotbar });

const SPAWN_X = 46.5, SPAWN_Z = 40.5;

function spawn() {
  const x = SPAWN_X, z = SPAWN_Z;
  player.spawn(x, surfaceHeight(world, x, z) + 0.05, z);
  // Face the mountain.
  const dx = world.sx * VOXEL * 0.66 - x, dz = world.sz * VOXEL * 0.6 - z;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = -0.12;
  player.update(0, new Set());
}
player.onFallOut = spawn;

let loaded = false;
setTimeout(() => {
  generateWorld(world, 1337, { avoid: [{ x: SPAWN_X, z: SPAWN_Z, r: 8 }] });
  spawn();
  hud.setLoading('Meshing chunks…');
}, 30);

// ---- input -------------------------------------------------------------------

const keys = new Set();
let locked = false;
let lastSpace = 0;

function lock() {
  if (!loaded) return;
  const p = canvas.requestPointerLock();
  // Browsers rate-limit re-locking right after Esc, and some embedded views block it entirely.
  if (p && p.catch) p.catch(() => hud.note('Mouse capture was blocked. Wait a second and click again, or open this page in a regular browser tab.'));
}

function openInventory() {
  hud.setInventory(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeInventory() {
  hud.setInventory(false);
  lock();
}

// No pause menu: clicking the view captures the mouse; Esc releases it and a
// small hint says how to resume.
canvas.addEventListener('click', () => {
  if (hud.inventoryOpen) closeInventory();
  else if (!locked) lock();
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked && hud.inventoryOpen) hud.setInventory(false);
  hud.setPaused(!locked);
  if (!locked) {
    keys.clear();
    interaction.releaseAll();
  }
});

document.addEventListener('mousemove', (e) => {
  if (locked) player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (locked) interaction.mouseDown(e.button);
});
document.addEventListener('mouseup', (e) => interaction.mouseUp(e.button));
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener(
  'wheel',
  (e) => {
    if (!locked) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY || e.deltaX);
    if (!dir) return;
    if (e.altKey) {
      const r = interaction.resize(-dir);
      if (r !== null) hud.flash(`Brush ${r.toFixed(1)} m`);
    } else hud.select(hotbar.selected + dir);
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (hud.inventoryOpen) {
    if ((e.code === 'KeyE' || e.code === 'Escape') && !e.repeat) closeInventory();
    else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) hud.select(n - 1);
    }
    return;
  }
  if (!locked) {
    if (e.code === 'KeyH' && !e.repeat) hud.toggleHelp();
    return;
  }
  if (['Space', 'Tab', 'F3', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;

  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 9) hud.select(n - 1);
  } else if (e.code === 'KeyE') openInventory();
  else if (e.code === 'KeyF') toggleFly();
  else if (e.code === 'KeyH') hud.toggleHelp();
  else if (e.code === 'F3' || e.code === 'Backquote' || e.key === '`') hud.toggleStats();
  else if (e.code === 'Space') {
    const now = performance.now();
    if (now - lastSpace < 280) { toggleFly(); lastSpace = 0; }
    else lastSpace = now;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); interaction.releaseAll(); });

function toggleFly() {
  hud.flash(player.toggleFly() ? 'Flying' : 'Walking');
}

// ---- loop ----------------------------------------------------------------------

let last = performance.now();
let fps = 60;
let statsTimer = 0;
let wasFlying = false;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

  if (locked) player.update(dt, keys);
  if (player.flying !== wasFlying) {
    wasFlying = player.flying;
    if (!player.flying) hud.flash('Walking');
  }
  interaction.update(dt, locked, keys.has('ShiftLeft') || keys.has('ShiftRight'));
  chunkMeshes.update(player.pos);

  // [ and ] swing the sun around the sky to show the shadows are live.
  const sunSpin = (keys.has('BracketRight') ? 1 : 0) - (keys.has('BracketLeft') ? 1 : 0);
  if (sunSpin) {
    sunAzimuth += sunSpin * dt * 0.6;
    shadow.setDirection(sunDirection(sunAzimuth));
  }
  shadow.update(chunkMeshes.list.concat(chunkMeshes.foliageList));
  uTime.value = now / 1000;

  if (!loaded && world.chunks.length && chunkMeshes.list.length && chunkMeshes.pending === 0) {
    loaded = true;
    hud.setLoading('');
  }

  renderer.render(scene, camera);

  statsTimer -= dt;
  if (statsTimer <= 0) {
    statsTimer = 0.25;
    const p = player.pos;
    hud.setStats(
      `FPS        ${fps.toFixed(0)}\n` +
      `Triangles  ${chunkMeshes.triangleCount().toLocaleString()} solid, ${chunkMeshes.foliageTriangleCount().toLocaleString()} foliage\n` +
      `Chunks     ${chunkMeshes.list.length} meshed, ${chunkMeshes.pending} pending\n` +
      `Last mesh  ${chunkMeshes.lastMeshMs.toFixed(1)} ms (${chunkMeshes.workerCount} workers)\n` +
      `Position   ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `Chunk      ${Math.floor(p.x / (world.size * VOXEL))} ${Math.floor(p.y / (world.size * VOXEL))} ${Math.floor(p.z / (world.size * VOXEL))}`,
    );
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the demo from the devtools console.
if (import.meta.env.DEV) window.demo = { shadow, world, player, interaction, hotbar, hud, chunkMeshes, camera, scene, renderer };
