import { PALETTE } from '../world/materials.js';
import { textureCanvas } from '../render/textures.js';
import { TOOLS } from '../tools/tools.js';

export const CONTROLS = [
  ['Move', 'W A S D'],
  ['Look', 'Mouse'],
  ['Jump / fly up', 'Space'],
  ['Sprint / fly down', 'Shift'],
  ['Toggle fly', 'F or double-tap Space'],
  ['Use tool', 'Left / right mouse'],
  ['Choose tool', 'Q / E or Z X C V B'],
  ['Choose material', '1–8 or mouse wheel'],
  ['Brush size', '[ / ] or Alt + wheel'],
  ['Help', 'H'],
  ['Stats', 'F3 or `'],
  ['Release mouse', 'Esc'],
];

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.tools = $('tools');
    this.hotbar = $('hotbar');
    this.status = $('status');
    this.matName = $('matname');
    this.toast = $('toast');
    this.stats = $('stats');
    this.help = $('help');
    this.hint = $('hint');
    this.loadingText = 'Loading…';
    this.started = false;

    this.tools.innerHTML = TOOLS.map(
      (t, i) => `<div class="tool" data-i="${i}"><span class="key">${t.key}</span><span>${t.name}</span></div>`,
    ).join('');

    PALETTE.forEach((m, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.id = m.id;
      slot.title = m.name;
      const c = textureCanvas(m.top, 36);
      slot.appendChild(c);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      slot.appendChild(num);
      if (m.hard) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.title = 'Block material (cubified)';
        slot.appendChild(b);
      }
      this.hotbar.appendChild(slot);
    });

    const rows = CONTROLS.map(([a, k]) => `<div>${a}</div><div class="k">${k}</div>`).join('');
    for (const el of document.querySelectorAll('.controls')) el.innerHTML = rows;
  }

  render(tools, player) {
    const t = TOOLS[tools.tool];
    for (const el of this.tools.children) el.classList.toggle('active', Number(el.dataset.i) === tools.tool);
    for (const el of this.hotbar.children) el.classList.toggle('active', Number(el.dataset.id) === tools.material);
    const brush = t.id === 'build' ? '' : `<span class="sep">·</span>Brush ${tools.radius}`;
    this.status.innerHTML =
      `<b>${t.name}</b><span class="sep">·</span>${t.hint}${brush}` +
      `<span class="sep">·</span>${player.flying ? 'Flying' : 'Walking'}`;
  }

  showMaterialName(name) {
    this.matName.textContent = name;
    this.matName.classList.add('show');
    clearTimeout(this.matTimer);
    this.matTimer = setTimeout(() => this.matName.classList.remove('show'), 1200);
  }

  flash(msg) {
    this.toast.textContent = msg;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 1100);
  }

  setPaused(paused) {
    if (!paused) this.started = true;
    document.body.classList.toggle('playing', !paused);
    this.updateHint();
  }

  setLoading(text) {
    this.loadingText = text || '';
    this.updateHint();
  }

  updateHint() {
    const playing = document.body.classList.contains('playing');
    if (playing) {
      this.hint.classList.add('hidden');
      return;
    }
    this.hint.classList.remove('hidden');
    this.hint.innerHTML = this.loadingText
      ? this.loadingText
      : `Click to ${this.started ? 'resume' : 'play'} <span class="k">· H for controls</span>`;
  }

  note(text) {
    this.hint.classList.remove('hidden');
    this.hint.textContent = text;
  }

  toggleHelp() {
    this.help.hidden = !this.help.hidden;
  }

  toggleStats() {
    this.stats.hidden = !this.stats.hidden;
  }

  setStats(text) {
    if (!this.stats.hidden) this.stats.textContent = text;
  }
}
