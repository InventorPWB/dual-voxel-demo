import { MATERIALS } from '../world/materials.js';
import { textureCanvas } from '../render/textures.js';

/**
 * Item icons, drawn in code: building items are the material's texture cut to
 * the shape's side silhouette; tools are simple flat drawings.
 */

// Silhouettes on a 16 × 16 grid (side view; slopes and stairs rise to the right).
const SILHOUETTES = {
  block: 'M2 2h12v12H2z',
  small: 'M5 7h7v7H5z',
  slab: 'M2 8h12v6H2z',
  slope: 'M2 14L14 2v12z',
  stairs: 'M2 14V8h6V2h6v12z',
  pillar: 'M4 3.5a4 1.5 0 0 1 8 0V12.5a4 1.5 0 0 1-8 0z',
  sphere: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2z',
};

const cache = new Map();

export function itemIcon(item, px = 40) {
  const key = `${item.id}:${px}`;
  const cached = cache.get(key);
  if (cached) return cloneCanvas(cached);
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (item.kind === 'build') drawBuild(g, item, px);
  else if (item.kind === 'plant') g.drawImage(textureCanvas(item.texture, px), 0, 0, px, px);
  else drawTool(g, item.id, px);
  cache.set(key, c);
  return cloneCanvas(c);
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function drawBuild(g, item, px) {
  const m = MATERIALS[item.material];
  const s = px / 16;
  const path = new Path2D(SILHOUETTES[item.shape.id]);
  g.save();
  g.scale(s, s);
  g.clip(path);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(textureCanvas(m.side, px), 0, 0, px, px);
  // Light from the top-left.
  const grad = g.createLinearGradient(0, 0, px, px);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  g.restore();
  g.save();
  g.scale(s, s);
  g.lineWidth = 1 / s * 1.5;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.stroke(path);
  g.restore();
}

function drawTool(g, id, px) {
  const s = px / 16;
  g.scale(s, s);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const handle = (x0, y0, x1, y1) => {
    g.strokeStyle = '#3b2a1a'; g.lineWidth = 2.6; line(x0, y0, x1, y1);
    g.strokeStyle = '#9a6b3f'; g.lineWidth = 1.6; line(x0, y0, x1, y1);
  };
  const line = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  const metal = (fill) => { g.fillStyle = fill; g.fill(); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 0.8; g.stroke(); };
  if (id === 'pickaxe') {
    handle(4, 13, 11, 5);
    g.beginPath(); g.moveTo(3, 5); g.quadraticCurveTo(9, 0.5, 14, 6); g.quadraticCurveTo(9, 3, 3, 5); metal('#c9ced6');
  } else if (id === 'shovel') {
    handle(3, 13, 9.5, 6.5);
    g.beginPath(); g.moveTo(9, 5); g.lineTo(12, 2); g.quadraticCurveTo(15, 2.5, 14, 6); g.lineTo(11, 9); g.closePath(); metal('#b8bec7');
  } else if (id === 'trowel') {
    handle(3, 13, 7, 9);
    g.beginPath(); g.moveTo(6.5, 8); g.lineTo(13.5, 2.5); g.lineTo(11, 11); g.closePath(); metal('#d4d8de');
  } else if (id === 'level') {
    g.beginPath(); g.rect(1.5, 6, 13, 4); metal('#d9a63a');
    g.beginPath(); g.rect(6, 6.9, 4, 2.2); g.fillStyle = '#8fe08a'; g.fill();
    g.beginPath(); g.arc(8, 8, 0.7, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  }
}
