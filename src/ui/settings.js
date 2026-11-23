/**
 * Settings: a small panel (O) for trying out rendering approaches. Values are
 * kept in localStorage so a reload keeps them. Each change calls `onChange`
 * with the key that changed and the whole settings object.
 */

const STORAGE_KEY = 'dual-voxel-demo.settings';

/**
 * What can be set, each with its default `value`, in panel order; `section`
 * entries are headings. `requires`: the key of a toggle this one only has an
 * effect under (its row is dimmed while that is off).
 */
export const SETTINGS = [
  { type: 'section', label: 'Textures' },
  {
    key: 'realisticTextures', label: 'Realistic textures', type: 'toggle', value: false,
    hint: 'Photographic textures (with normal and roughness maps) and photographed plants instead of the 32×32 pixel art. Changing it reloads the page, which regenerates the world.',
  },
  {
    key: 'normalMaps', label: 'Normal maps', type: 'toggle', value: true, requires: 'realisticTextures',
    hint: 'Surface relief on ground, walls and bark. Off: the textures lie flat.',
  },
  { type: 'section', label: 'Lighting' },
  {
    key: 'shaderLighting', label: 'Shader lighting', type: 'toggle', value: true,
    hint: 'Lighting like game shader packs: a strong warm sun against a cool sky light, physically based materials and tone mapping, with the effects below. Off: the original flat lighting.',
  },
  {
    key: 'brightness', label: 'Brightness', type: 'range', value: 1, min: 0.5, max: 1.6, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`, requires: 'shaderLighting',
  },
  {
    key: 'reflections', label: 'Reflections', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'The sun\'s highlights and the sky reflected off surfaces, by their roughness.',
  },
  {
    key: 'ambientOcclusion', label: 'Ambient occlusion', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'Darkens creases, the feet of walls and grass, and under trees.',
  },
  {
    key: 'sunShafts', label: 'Sun shafts', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'Rays of light through leaves and over ridges when you look towards the sun.',
  },
  {
    key: 'bloom', label: 'Bloom', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'A glow round the sun and anything brighter than white.',
  },
  {
    key: 'clouds', label: 'Clouds', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'Drifting clouds in the sky.',
  },
  {
    key: 'vignette', label: 'Vignette', type: 'toggle', value: true, requires: 'shaderLighting',
    hint: 'Slightly darker corners.',
  },
  { type: 'section', label: 'Plants' },
  {
    key: 'leafInterior', label: 'Leaves inside crowns', type: 'toggle', value: true,
    hint: 'Sparse leaf cards through the inside of each crown, seen through its gaps and when you are in the leaves.',
  },
];
const VALUES = SETTINGS.filter((s) => s.key);

/** A setting's saved value (or its default), before the panel exists (see boot.js). */
export function savedSetting(key) {
  const def = SETTINGS.find((s) => s.key === key).value;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return key in saved && typeof saved[key] === typeof def ? saved[key] : def;
  } catch {
    return def;
  }
}

export class Settings {
  constructor() {
    this.values = Object.fromEntries(VALUES.map((s) => [s.key, s.value]));
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const s of VALUES) if (s.key in saved && typeof saved[s.key] === typeof s.value) this.values[s.key] = saved[s.key];
    } catch { /* storage unavailable: defaults */ }
    this.onChange = null;
    this.panel = document.getElementById('settings');
    this.syncs = []; // refresh each control from `values`
    this.build();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    this.syncDependents();
    this.onChange?.(key, this.values);
  }

  /** Dim the rows whose `requires` toggle is off. */
  syncDependents() {
    for (const [row, s] of this.dependents) row.classList.toggle('inactive', !this.values[s.requires]);
  }

  get open() {
    return !this.panel.hidden;
  }

  setOpen(open) {
    if (open) for (const sync of this.syncs) sync();
    this.panel.hidden = !open;
    document.body.classList.toggle('settings', open);
  }

  build() {
    const body = this.panel.querySelector('.body');
    this.dependents = [];
    for (const s of SETTINGS) {
      if (s.type === 'section') {
        const h = document.createElement('div');
        h.className = 'section';
        h.textContent = s.label;
        body.appendChild(h);
        continue;
      }
      const row = document.createElement('div');
      if (s.requires) this.dependents.push([row, s]);
      row.className = 'setting';
      const label = document.createElement(s.type === 'toggle' ? 'label' : 'div');
      label.className = 'label';
      label.textContent = s.label;
      row.appendChild(label);

      if (s.type === 'choice') {
        const group = document.createElement('div');
        group.className = 'choices';
        const hint = document.createElement('div');
        hint.className = 'hint';
        const sync = () => {
          for (const b of group.children) b.classList.toggle('on', b.dataset.v === this.values[s.key]);
          hint.textContent = s.options.find((o) => o[0] === this.values[s.key])?.[2] || '';
        };
        for (const [v, name] of s.options) {
          const b = document.createElement('button');
          b.dataset.v = v;
          b.textContent = name;
          b.addEventListener('click', () => { this.set(s.key, v); sync(); });
          group.appendChild(b);
        }
        sync();
        this.syncs.push(sync);
        row.append(group, hint);
      } else if (s.type === 'range') {
        const wrap = document.createElement('div');
        wrap.className = 'range';
        const input = document.createElement('input');
        input.type = 'range';
        Object.assign(input, { min: s.min, max: s.max, step: s.step });
        input.value = this.values[s.key];
        const out = document.createElement('span');
        out.textContent = s.format(this.values[s.key]);
        input.addEventListener('input', () => {
          const v = Number(input.value);
          out.textContent = s.format(v);
          this.set(s.key, v);
        });
        this.syncs.push(() => {
          input.value = this.values[s.key];
          out.textContent = s.format(this.values[s.key]);
        });
        wrap.append(input, out);
        row.appendChild(wrap);
      } else if (s.type === 'toggle') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this.values[s.key];
        input.addEventListener('change', () => this.set(s.key, input.checked));
        this.syncs.push(() => { input.checked = this.values[s.key]; });
        label.prepend(input);
        label.classList.add('check');
      }
      if (s.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = s.hint;
        row.appendChild(hint);
      }
      body.appendChild(row);
    }
    this.syncDependents();
  }
}
