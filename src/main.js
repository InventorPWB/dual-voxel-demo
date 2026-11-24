import * as THREE from 'three';
import { World, VOXEL } from './world/World.js';
import { generateWorld, surfaceHeight } from './world/generate.js';
import { createChunkMaterials, SKY_COLOR, SUN_AZIMUTH, sunDirection } from './render/terrainMaterial.js';
import { createFoliageMaterials } from './render/foliageMaterial.js';
import { lightingUniforms, setShaderLighting, shaderLighting } from './render/lighting.js';
import { createSky } from './render/Sky.js';
import { PostFX } from './render/PostFX.js';
import { attachMipmaps } from './render/textureArray.js';
import { hasPhotos } from './render/textures.js';
import { SunShadow } from './render/SunShadow.js';
import { ChunkMeshes, WATER_LAYER } from './render/ChunkMeshes.js';
import { createWaterMaterial, setWaterRefraction } from './render/waterMaterial.js';
import { WaterHeight } from './render/waterHeight.js';
import { Splashes } from './render/Splashes.js';
import { FluidSim } from './world/FluidSim.js';
import { FluxSim } from './world/FluxSim.js';
import { FluidCore } from './world/fluidCore.js';
import { Player } from './player/Player.js';
import { Interaction } from './items/interaction.js';
import { defaultHotbar } from './items/items.js';
import { Hud, Hotbar } from './ui/hud.js';
import { Settings, savedSetting } from './ui/settings.js';

// ---- scene ------------------------------------------------------------------

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const flatSky = new THREE.Color(SKY_COLOR);
scene.background = flatSky;
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  post?.setSize(window.innerWidth, window.innerHeight);
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
attachMipmaps(renderer);
// Water: the simulation, which of it is a source (fluidCore.js), and how it's drawn.
// The new water (Settings: water with momentum) or the earlier cellular water:
// chosen at start (changing it reloads).
const fluxWater = savedSetting('fluxWater');
const fluid = fluxWater ? new FluxSim(world) : new FluidSim(world);
const core = new FluidCore(world, fluid);
const waterHeight = new WaterHeight(world, core);
const waterMaterial = createWaterMaterial(shadow);
const chunkMeshes = new ChunkMeshes(world, scene, createChunkMaterials(shadow, waterHeight), createFoliageMaterials(shadow), waterMaterial);
camera.layers.enable(WATER_LAYER);
// The contoured surface draws thin water itself, fading in over its first few
// centimetres; the cellular mesher leaves shallows to a film painted on the ground.
chunkMeshes.waterSurface = fluxWater;
waterMaterial.uniforms.uFade.value.set(fluxWater ? 0.0 : 0.08, fluxWater ? 0.04 : 0.18);
waterMaterial.uniforms.uFlowScale.value = fluxWater ? 3 : 18;
waterHeight.uniforms.uFilmOn.value = fluxWater ? 0 : 1;
const uTime = lightingUniforms(shadow).uTime;
chunkMeshes.onChange = () => { shadow.dirty = true; };

// Shader lighting (Settings): a sky dome instead of the flat sky colour, and
// the frame drawn through PostFX (occlusion, sun shafts, bloom, tone mapping).
const sky = createSky(shadow);
scene.add(sky);
const post = new PostFX(renderer, shadow.direction);
post.setSize(window.innerWidth, window.innerHeight);
post.setGrade(hasPhotos() ? { exposure: 0.85, saturation: 1 } : { exposure: 0.72, saturation: 0.8 });
function setLighting(on) {
  setShaderLighting(on);
  sky.visible = on;
  scene.background = on ? null : flatSky;
}

// ---- settings ------------------------------------------------------------------

const settings = new Settings();
function applySettings(key) {
  const v = settings.values;
  // Textures are built once, at start (boot.js): start again with the other set.
  if (key === 'realisticTextures' || key === 'fluxWater') {
    location.reload();
    return;
  }
  setLighting(v.shaderLighting);
  // The visual settings, applied live.
  post.setEffects({ ao: v.ambientOcclusion, rays: v.sunShafts, bloom: v.bloom, vignette: v.vignette, brightness: v.brightness });
  sky.setClouds(v.clouds);
  // Water: refraction and the rest need shader lighting's pass of its own.
  const refract = v.shaderLighting && v.waterEffects;
  setWaterRefraction(waterMaterial, refract);
  post.setWater(waterMaterial, WATER_LAYER, refract);
  waterHeight.setEnabled(refract);
  fluid.paused = !v.waterSim;
  const lu = lightingUniforms(shadow);
  lu.uSpecularScale.value = v.reflections ? 1 : 0;
  lu.uNormalStrength.value = v.normalMaps ? 1 : 0;
  // Leaves inside crowns are meshed in: re-mesh when it changes (not on the
  // first call; nothing's meshed yet).
  const options = { interiorCards: v.leafInterior };
  if (!meshedWith || options.interiorCards !== meshedWith.interiorCards) {
    chunkMeshes.setFoliageOptions(options, !!key);
    meshedWith = options;
  }
}
let meshedWith = null;
applySettings();
settings.onChange = applySettings;

const player = new Player(world, camera, () => chunkMeshes.colliders);
// Currents: the flux water's own velocity (the cellular water's are guessed from its slope).
if (fluxWater) player.currentAt = (x, y, z, out) => fluid.velocity(x, y, z, out);
const splashes = new Splashes(scene);
player.onSplash = (pos, speed) => splashes.burst(pos.x, player.waterLevel, pos.z, Math.min(1.5, speed / 8));

const lu0 = lightingUniforms(shadow);
const airFog = { color: lu0.uFogColor.value.clone(), density: lu0.uFogDensity.value };
let wasUnderwater = false;
function setUnderwater(on, time) {
  post.setUnderwater(on, time);
  if (on === wasUnderwater) return;
  wasUnderwater = on;
  // Without shader lighting, plain fog does it: close and blue-green.
  lu0.uFogColor.value.copy(on ? new THREE.Color().setHex(0x1d5560, THREE.LinearSRGBColorSpace) : airFog.color);
  lu0.uFogDensity.value = on ? 0.09 : airFog.density;
}
const interaction = new Interaction({ world, scene, camera, chunkMeshes, player, hotbar, fluid, core, onMessage: (m) => hud.flash(m) });

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
  const { water } = generateWorld(world, 1337, { avoid: [{ x: SPAWN_X, z: SPAWN_Z, r: 10 }] });
  // The sea and the lake start out still and as sources; the river is set running.
  core.rebuild(true);
  if (water) {
    for (let i = 0; i < water.course.length; i += 4) {
      const [x, z] = water.course[i];
      const vx = Math.floor(x / VOXEL), vz = Math.floor(z / VOXEL), vy = Math.floor(water.bed[i] / VOXEL);
      fluid.wake([vx - 5, vy - 2, vz - 5, vx + 5, Math.ceil(water.lake.level / VOXEL) + 1, vz + 5]);
    }
  }
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

function openSettings() {
  if (hud.inventoryOpen) hud.setInventory(false);
  settings.setOpen(true);
  hud.updateHint();
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeSettings() {
  settings.setOpen(false);
  hud.updateHint();
  lock();
}

// No pause menu: clicking the view captures the mouse; Esc releases it and a
// small hint says how to resume.
canvas.addEventListener('click', () => {
  if (settings.open) closeSettings();
  else if (hud.inventoryOpen) closeInventory();
  else if (!locked) lock();
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked && hud.inventoryOpen) hud.setInventory(false);
  if (locked && settings.open) settings.setOpen(false);
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
  if (settings.open) {
    if ((e.code === 'KeyO' || e.code === 'Escape') && !e.repeat) closeSettings();
    return;
  }
  if (e.code === 'KeyO' && !e.repeat) {
    openSettings();
    return;
  }
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
    // (Not while swimming, where Space is pressed over and over.)
    if (now - lastSpace < 280 && !player.inWater) { toggleFly(); lastSpace = 0; }
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
  if (loaded) {
    fluid.update(dt, player.pos);
    core.update();
    waterHeight.update();
  }
  chunkMeshes.update(player.pos);
  splashes.update(dt);
  // Under water: the view's fogged and tinted (PostFX; plain fog without shader lighting).
  setUnderwater(player.underwater && !player.flying, now / 1000);

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

  if (shaderLighting()) post.render(scene, camera);
  else renderer.render(scene, camera);

  statsTimer -= dt;
  if (statsTimer <= 0) {
    statsTimer = 0.25;
    const p = player.pos;
    hud.setStats(
      `FPS        ${fps.toFixed(0)}\n` +
      `Triangles  ${chunkMeshes.triangleCount().toLocaleString()} solid, ${chunkMeshes.foliageTriangleCount().toLocaleString()} foliage\n` +
      `Chunks     ${chunkMeshes.list.length} meshed, ${chunkMeshes.pending} pending\n` +
      `Last mesh  ${chunkMeshes.lastMeshMs.toFixed(1)} ms (${chunkMeshes.workerCount} workers)\n` +
      `Water      ${fluid.stats.active.toLocaleString()} active, ${fluid.stats.ms.toFixed(1)} ms, ${core.coreCount} source tiles, ${chunkMeshes.waterTriangleCount().toLocaleString()} triangles\n` +
      `Position   ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `Chunk      ${Math.floor(p.x / (world.size * VOXEL))} ${Math.floor(p.y / (world.size * VOXEL))} ${Math.floor(p.z / (world.size * VOXEL))}`,
    );
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the demo from the devtools console.
if (import.meta.env.DEV) window.demo = { settings, shadow, post, sky, world, fluid, core, player, interaction, hotbar, hud, chunkMeshes, camera, scene, renderer };
