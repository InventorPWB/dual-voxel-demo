import { INVENTORY, HOTBAR_SIZE } from '../items/items.js';
import { MATERIALS } from '../world/materials.js';
import { SHAPES } from '../world/shapes.js';
import { itemIcon } from './icons.js';

export const CONTROLS = [
  ['Move', 'W A S D'],
  ['Look', 'Mouse'],
  ['Jump / fly up', 'Space'],
  ['Sprint / fly down', 'Shift'],
  ['Toggle fly', 'F or double-tap Space'],
  ['Break / dig / chop', 'Left mouse'],
  ['Place / use', 'Right mouse'],
  ['Paint / lay a loose log', 'Shift + right mouse'],
  ['Choose item', '1–9 or mouse wheel'],
  ['Inventory', 'E'],
  ['Settings', 'O'],
  ['Brush size', 'Alt + wheel'],
  ['Move the sun', '[ and ]'],
  ['Help', 'H'],
  ['Stats', 'F3 or `'],
  ['Release mouse', 'Esc'],
];

const $ = (id) => document.getElementById(id);

/** The hotbar's contents: nine slots of items and the selected slot. */
export class Hotbar {
  constructor(items) {
    this.slots = items.slice(0, HOTBAR_SIZE);
    while (this.slots.length < HOTBAR_SIZE) this.slots.push(null);
    this.selected = 0;
  }

  get item() {
    return this.slots[this.selected];
  }
}

export class Hud {
  constructor(hotbar) {
    this.hotbarState = hotbar;
    this.hotbar = $('hotbar');
    this.itemName = $('itemname');
    this.toast = $('toast');
    this.stats = $('stats');
    this.help = $('help');
    this.hint = $('hint');
    this.inventory = $('inventory');
    this.loadingText = 'Loading…';
    this.started = false;
    this.onChange = null;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.i = i;
      slot.addEventListener('click', () => this.select(i));
      slot.addEventListener('dragover', (e) => e.preventDefault());
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        const item = this.dragged;
        if (item) this.assign(i, item);
      });
      this.hotbar.appendChild(slot);
    }
    this.renderHotbar();
    this.buildInventory();

    const rows = CONTROLS.map(([a, k]) => `<div>${a}</div><div class="k">${k}</div>`).join('');
    for (const el of document.querySelectorAll('.controls')) el.innerHTML = rows;
  }

  // ---- hotbar -------------------------------------------------------------------

  renderHotbar() {
    const { slots, selected } = this.hotbarState;
    [...this.hotbar.children].forEach((slot, i) => {
      slot.classList.toggle('active', i === selected);
      slot.replaceChildren();
      const item = slots[i];
      if (item) {
        slot.appendChild(itemIcon(item, 36));
        slot.title = item.name;
      } else {
        slot.title = '';
      }
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      slot.appendChild(num);
    });
  }

  select(i) {
    const h = this.hotbarState;
    h.selected = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.renderHotbar();
    this.showItemName();
    this.onChange?.();
  }

  assign(i, item) {
    this.hotbarState.slots[i] = item;
    this.hotbarState.selected = i;
    this.renderHotbar();
    this.showItemName();
    this.onChange?.();
  }

  showItemName() {
    const item = this.hotbarState.item;
    this.itemName.innerHTML = item ? `${item.name}<span>${item.use}</span>` : '';
    this.itemName.classList.add('show');
    clearTimeout(this.nameTimer);
    this.nameTimer = setTimeout(() => this.itemName.classList.remove('show'), 1800);
  }

  // ---- inventory ------------------------------------------------------------------

  buildInventory() {
    const inv = this.inventory;
    const label = inv.querySelector('.hover');
    const cell = (item) => {
      const el = document.createElement('div');
      el.className = 'item';
      el.draggable = true;
      el.appendChild(itemIcon(item, 40));
      el.addEventListener('mouseenter', () => { label.textContent = item.name; });
      el.addEventListener('mouseleave', () => { label.textContent = ''; });
      el.addEventListener('click', () => this.assign(this.hotbarState.selected, item));
      el.addEventListener('dragstart', (e) => {
        this.dragged = item;
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dragend', () => { this.dragged = null; });
      return el;
    };

    const tools = inv.querySelector('.tools');
    for (const t of INVENTORY.tools) tools.appendChild(cell(t));
    const plants = inv.querySelector('.plants');
    for (const p of INVENTORY.plants) plants.appendChild(cell(p));

    const grid = inv.querySelector('.grid');
    grid.style.gridTemplateColumns = `auto repeat(${SHAPES.length}, auto)`;
    grid.appendChild(document.createElement('div'));
    for (const s of SHAPES) {
      const h = document.createElement('div');
      h.className = 'colhead';
      h.textContent = s.name;
      grid.appendChild(h);
    }
    for (const row of INVENTORY.rows) {
      const name = document.createElement('div');
      name.className = 'rowhead';
      name.textContent = MATERIALS[row[0].material].name;
      grid.appendChild(name);
      for (const item of row) grid.appendChild(cell(item));
    }
  }

  get inventoryOpen() {
    return !this.inventory.hidden;
  }

  setInventory(open) {
    this.inventory.hidden = !open;
    document.body.classList.toggle('inventory', open);
    this.updateHint();
  }

  // ---- messages -------------------------------------------------------------------

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
    if (playing || this.inventoryOpen || document.body.classList.contains('settings')) {
      this.hint.classList.add('hidden');
      return;
    }
    this.hint.classList.remove('hidden');
    this.hint.innerHTML = this.loadingText
      ? this.loadingText
      : `Click to ${this.started ? 'resume' : 'play'} <span class="k">· H for controls · O for settings</span>`;
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
