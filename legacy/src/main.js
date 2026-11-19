import * as THREE from 'three';
import { World } from './world/World.js';
import { generateWorld, surfaceHeight } from './world/generate.js';
import { MATERIALS } from './world/materials.js';
import { createTerrainMaterial, SKY_COLOR } from './render/terrainMaterial.js';
import { ChunkMeshes } from './render/ChunkMeshes.js';
import { Player } from './player/Player.js';
import { ToolSystem, TOOLS } from './tools/tools.js';
import { Hud } from './ui/hud.js';

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

const hud = new Hud();
hud.setLoading('Generating terrain…');

const world = new World(4, 3, 4); // 128 × 96 × 128 voxels in 32³ chunks
const chunkMeshes = new ChunkMeshes(world, scene, createTerrainMaterial());
const player = new Player(world, camera, () => chunkMeshes.list);
const tools = new ToolSystem({ world, scene, camera, chunkMeshes, player, onChange: () => hud.render(tools, player) });

function spawn() {
  const x = 46.5, z = 40.5;
  player.spawn(x, surfaceHeight(world, Math.floor(x), Math.floor(z)) + 0.6, z);
  // Face the mountain.
  const dx = world.sx * 0.66 - x, dz = world.sz * 0.6 - z;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = -0.12;
  player.update(0, new Set());
}
player.onFallOut = spawn;

let loaded = false;
setTimeout(() => {
  generateWorld(world);
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

// No pause menu: clicking the view captures the mouse; Esc releases it and a
// small hint says how to resume.
canvas.addEventListener('click', () => { if (!locked) lock(); });

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  hud.setPaused(!locked);
  if (!locked) {
    keys.clear();
    tools.releaseAll();
  }
});

document.addEventListener('mousemove', (e) => {
  if (locked) player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (locked) tools.mouseDown(e.button);
});
document.addEventListener('mouseup', (e) => tools.mouseUp(e.button));
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener(
  'wheel',
  (e) => {
    if (!locked) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY || e.deltaX);
    if (!dir) return;
    if (e.altKey) tools.setRadius(tools.radius - dir);
    else selectMaterial(tools.material + dir);
  },
  { passive: false },
);

function selectMaterial(id) {
  tools.setMaterial(id);
  hud.showMaterialName(MATERIALS[tools.material].name);
}

const TOOL_KEYS = Object.fromEntries(TOOLS.map((t, i) => [`Key${t.key}`, i]));

window.addEventListener('keydown', (e) => {
  if (!locked) {
    if (e.code === 'KeyH' && !e.repeat) hud.toggleHelp();
    return;
  }
  if (['Space', 'Tab', 'F3', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);

  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 8) selectMaterial(n);
  } else if (e.code in TOOL_KEYS) tools.setTool(TOOL_KEYS[e.code]);
  else if (e.code === 'KeyQ') tools.setTool(tools.tool - 1);
  else if (e.code === 'KeyE') tools.setTool(tools.tool + 1);
  else if (e.code === 'BracketLeft' || e.key === '[') tools.setRadius(tools.radius - 1);
  else if (e.code === 'BracketRight' || e.key === ']') tools.setRadius(tools.radius + 1);
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
window.addEventListener('blur', () => { keys.clear(); tools.releaseAll(); });

function toggleFly() {
  const flying = player.toggleFly();
  hud.flash(flying ? 'Flying' : 'Walking');
  hud.render(tools, player);
}

hud.render(tools, player);

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
  if (player.flying !== wasFlying) { wasFlying = player.flying; hud.render(tools, player); }
  tools.update(dt, locked);
  chunkMeshes.update(player.pos);

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
      `Triangles  ${chunkMeshes.triangleCount().toLocaleString()}\n` +
      `Chunks     ${chunkMeshes.list.length} meshed, ${chunkMeshes.pending} pending\n` +
      `Last mesh  ${chunkMeshes.lastMeshMs.toFixed(1)} ms (${chunkMeshes.workerCount} workers)\n` +
      `Position   ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `Chunk      ${Math.floor(p.x / world.size)} ${Math.floor(p.y / world.size)} ${Math.floor(p.z / world.size)}`,
    );
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the demo from the devtools console.
if (import.meta.env.DEV) window.demo = { world, player, tools, chunkMeshes, camera, scene, renderer };
