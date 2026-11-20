/**
 * Building shapes.
 *
 * Each voxel is either smooth terrain (state 0) or holds a building shape
 * state: a cube, a 45° wedge, a quarter-round (pillar segment) or a sphere
 * octant, in some orientation. Building voxels are drawn as their exact
 * polygons (generated here, no assets), the way Minecraft draws blocks, so
 * pieces meet in any combination with every face and corner exact. Faces
 * fully covered by a neighbouring piece are skipped.
 *
 * Inventory items (block, slope, pillar, ...) are patterns of these voxel
 * states. A 1 m slope is a wedge, a cube and a wedge per column, giving one
 * flat 45° face; a pillar is four quarter-rounds; a sphere eight octants.
 */

// ------------------------------------------------------------ voxel states

export const SMOOTH = 0;
export const CUBE = 1;
/** Wedge rising toward direction `rot` (0 +z, 1 +x, 2 −z, 3 −x); `flip` = upside down. */
export const wedgeState = (rot, flip = false) => 2 + (((rot % 4) + 4) % 4) + (flip ? 4 : 0);
/** Quarter-round: a quarter cylinder whose axis runs up the voxel edge at x = cx, z = cz (0 or 1). */
export const roundState = (cx, cz) => 10 + cx + 2 * cz;
/** Sphere octant: radius 1 voxel, centred on the voxel corner (cx, cy, cz) (each 0 or 1). */
export const octantState = (cx, cy, cz) => 14 + cx + 2 * cy + 4 * cz;
export const STATE_COUNT = 22;

/** Face directions: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z. */
export const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const OPPOSITE = [1, 0, 3, 2, 5, 4];
const FULL = 'full';
const ARC = 6; // segments per quarter circle

/**
 * Geometry of each state in unit voxel coordinates:
 *   faces: [{ dir, key, pos, nrm }] — dir is the voxel side the face lies on
 *   (or −1 for faces inside the voxel, like a wedge's slope); key describes
 *   its outline on that side, for culling against neighbours; pos/nrm are
 *   triangle vertices and normals (flat arrays).
 */
const geometry = [];

export function stateGeometry(state) {
  if (!geometry[state]) geometry[state] = buildState(state);
  return geometry[state];
}

/** Outline of the face on side `dir` ('full', a key, or null if none). */
export function faceKey(state, dir) {
  const g = stateGeometry(state);
  return g.keys[dir];
}

/** Is a face of state `s` on side `dir` hidden by neighbour state `n` (sharing that side)? */
export function faceHidden(s, dir, n) {
  if (!n) return false;
  const theirs = faceKey(n, OPPOSITE[dir]);
  if (!theirs) return false;
  return theirs === FULL || theirs === faceKey(s, dir);
}

function buildState(state) {
  let polys;
  if (state === CUBE) polys = cubePolys();
  else if (state >= 2 && state < 10) {
    const rot = (state - 2) % 4, flip = state >= 6;
    polys = wedgePolys().map((p) => transform(p, rot, flip));
  } else if (state >= 10 && state < 14) {
    const c = state - 10;
    polys = roundPolys(c & 1, (c >> 1) & 1);
  } else if (state >= 14 && state < 22) {
    const c = state - 14;
    polys = octantPolys(c & 1, (c >> 1) & 1, (c >> 2) & 1);
  } else polys = [];

  const faces = [];
  const keys = [null, null, null, null, null, null];
  for (const p of polys) {
    const dir = sideOf(p.verts);
    const pos = [], nrm = [];
    // Fan-triangulate (all polygons are convex), winding counter-clockwise seen from outside.
    for (let i = 1; i + 1 < p.verts.length; i++) {
      let tri = [0, i, i + 1];
      const [a, b, c] = tri.map((k) => p.verts[k]);
      const n = cross(sub(b, a), sub(c, a));
      const want = p.normals ? avg(tri.map((k) => p.normals[k])) : p.normal;
      if (dot(n, want) < 0) tri = [0, i + 1, i];
      for (const k of tri) {
        pos.push(...p.verts[k]);
        nrm.push(...(p.normals ? p.normals[k] : p.normal));
      }
    }
    const key = dir >= 0 ? outlineKey(p.verts, dir) : null;
    if (dir >= 0) keys[dir] = keys[dir] ? `${keys[dir]}+${key}` : key;
    faces.push({ dir, key, pos, nrm });
  }
  return { faces, keys };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const avg = (vs) => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** Which voxel side all the vertices lie on, or −1. */
function sideOf(verts) {
  for (let axis = 0; axis < 3; axis++)
    for (const v of [1, 0])
      if (verts.every((p) => near(p[axis], v))) return axis * 2 + (v === 1 ? 0 : 1);
  return -1;
}

/** Outline of a face on a voxel side, in that side's 2D coordinates (same for both voxels sharing it). */
function outlineKey(verts, dir) {
  const axis = dir >> 1;
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const pts = verts.map((p) => `${p[i].toFixed(3)},${p[j].toFixed(3)}`);
  const uniq = [...new Set(pts)].sort();
  return uniq.join('|') === '0.000,0.000|0.000,1.000|1.000,0.000|1.000,1.000' ? FULL : uniq.join('|');
}

function quad(a, b, c, d, normal) {
  return { verts: [a, b, c, d], normal };
}

function cubePolys() {
  return [
    quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]),
    quad([0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [-1, 0, 0]),
    quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]),
    quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0]),
    quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]),
    quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, -1]),
  ];
}

/** Wedge rising toward +z: solid where y ≤ z. */
function wedgePolys() {
  const s = Math.SQRT1_2;
  return [
    quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0]),
    quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]),
    quad([0, 0, 0], [0, 1, 1], [1, 1, 1], [1, 0, 0], [0, s, -s]),
    { verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1]], normal: [-1, 0, 0] },
    { verts: [[1, 0, 0], [1, 1, 1], [1, 0, 1]], normal: [1, 0, 0] },
  ];
}

/** Rotate about the voxel's vertical axis (rot quarter turns: +z → +x → −z → −x), then flip upside down. */
function transform(poly, rot, flip) {
  const tp = (p) => {
    let [x, y, z] = p;
    for (let r = 0; r < rot; r++) [x, z] = [z, 1 - x];
    if (flip) y = 1 - y;
    return [x, y, z];
  };
  const tn = (n) => {
    let [x, y, z] = n;
    for (let r = 0; r < rot; r++) [x, z] = [z, -x];
    if (flip) y = -y;
    return [x, y, z];
  };
  return {
    verts: poly.verts.map(tp),
    normal: poly.normal && tn(poly.normal),
    normals: poly.normals && poly.normals.map(tn),
  };
}

/** Quarter cylinder (radius 1) with its axis on the vertical voxel edge at (ax, az). */
function roundPolys(ax, az) {
  const sx = ax ? -1 : 1, sz = az ? -1 : 1;
  const arc = [];
  for (let i = 0; i <= ARC; i++) {
    const t = (i / ARC) * (Math.PI / 2);
    arc.push([Math.sin(t), Math.cos(t)]);
  }
  const at = (a, y) => [ax + sx * a[0], y, az + sz * a[1]];
  const polys = [
    { verts: [[ax, 1, az], ...arc.map((a) => at(a, 1))], normal: [0, 1, 0] },
    { verts: [[ax, 0, az], ...arc.map((a) => at(a, 0))], normal: [0, -1, 0] },
    quad([ax, 0, az], [ax, 1, az], [ax, 1, az + sz], [ax, 0, az + sz], [-sx, 0, 0]),
    quad([ax, 0, az], [ax + sx, 0, az], [ax + sx, 1, az], [ax, 1, az], [0, 0, -sz]),
  ];
  for (let i = 0; i < ARC; i++) {
    const a = arc[i], b = arc[i + 1];
    const n = (p) => [sx * p[0], 0, sz * p[1]];
    polys.push({ verts: [at(a, 0), at(b, 0), at(b, 1), at(a, 1)], normals: [n(a), n(b), n(b), n(a)] });
  }
  return polys;
}

/** Sphere octant (radius 1) centred on the voxel corner (cx, cy, cz). */
function octantPolys(cx, cy, cz) {
  const c = [cx, cy, cz];
  const s = c.map((v) => (v ? -1 : 1)); // toward the voxel's inside
  const pt = (d) => [c[0] + s[0] * d[0], c[1] + s[1] * d[1], c[2] + s[2] * d[2]];
  const polys = [];
  // Flat quarter discs on the three planes through the centre.
  for (let axis = 0; axis < 3; axis++) {
    const [i, j] = [(axis + 1) % 3, (axis + 2) % 3];
    const verts = [pt([0, 0, 0])];
    for (let k = 0; k <= ARC; k++) {
      const t = (k / ARC) * (Math.PI / 2);
      const d = [0, 0, 0];
      d[i] = Math.cos(t); d[j] = Math.sin(t);
      verts.push(pt(d));
    }
    const normal = [0, 0, 0];
    normal[axis] = -s[axis];
    polys.push({ verts, normal });
  }
  // Curved patch: a grid over the octant (polar angle from y, azimuth in xz),
  // with the same subdivision as the discs' arcs so their edges match exactly.
  const N = ARC;
  const dirAt = (a, b) => {
    const th = (a / N) * (Math.PI / 2), ph = (b / N) * (Math.PI / 2);
    return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
  };
  for (let a = 0; a < N; a++)
    for (let b = 0; b < N; b++) {
      const ds = [dirAt(a, b), dirAt(a + 1, b), dirAt(a + 1, b + 1), dirAt(a, b + 1)];
      const verts = ds.map(pt);
      const normals = ds.map((d) => [s[0] * d[0], s[1] * d[1], s[2] * d[2]]);
      if (a === 0) polys.push({ verts: [verts[0], verts[1], verts[2]], normals: [normals[0], normals[1], normals[2]] });
      else polys.push({ verts, normals });
    }
  return polys;
}

/** Is local point (x, y, z) (each 0..1 within the voxel) inside shape state `state`? */
export function stateContains(state, x, y, z) {
  if (state === CUBE) return true;
  if (state >= 2 && state < 10) {
    const rot = (state - 2) % 4;
    if (state >= 6) y = 1 - y;
    for (let r = 0; r < rot; r++) [x, z] = [1 - z, x]; // undo the rotation
    return y <= z;
  }
  if (state >= 10 && state < 14) {
    const c = state - 10;
    return (x - (c & 1)) ** 2 + (z - ((c >> 1) & 1)) ** 2 <= 1;
  }
  if (state >= 14 && state < 22) {
    const c = state - 14;
    return (x - (c & 1)) ** 2 + (y - ((c >> 1) & 1)) ** 2 + (z - ((c >> 2) & 1)) ** 2 <= 1;
  }
  return false;
}

// ------------------------------------------------------------------ items

/**
 * Inventory shapes, as patterns of voxel states inside a local footprint
 * (y up, +z the way slopes and stairs rise: away from the player).
 * `cells(u, v, w)` returns the state for local voxel (u, v, w), or 0 for none.
 * `lattice` is the build grid the item snaps to (voxels per axis).
 */
export const SHAPES = [
  { id: 'block', name: 'Block', size: [2, 2, 2], lattice: [2, 2, 2], cells: () => CUBE },
  { id: 'small', name: 'Small Block', size: [1, 1, 1], lattice: [1, 1, 1], cells: () => CUBE },
  { id: 'slab', name: 'Slab', size: [2, 1, 2], lattice: [2, 1, 2], cells: () => CUBE },
  {
    id: 'slope', name: 'Slope', size: [2, 2, 2], lattice: [2, 2, 2], oriented: true,
    // Per column: wedge at the toe, cube behind it, wedge on top of that.
    cells: (u, v, w, rot, flip) => (v === 0 ? (w === 0 ? wedgeState(rot, flip) : CUBE) : w === 1 ? wedgeState(rot, flip) : 0),
  },
  {
    id: 'stairs', name: 'Stairs', size: [2, 2, 2], lattice: [2, 2, 2], oriented: true,
    cells: (u, v, w) => (v === 0 || w === 1 ? CUBE : 0),
  },
  {
    id: 'pillar', name: 'Pillar', size: [2, 2, 2], lattice: [2, 2, 2],
    // Four quarter-rounds around the footprint's centre line.
    cells: (u, v, w) => roundState(u === 0 ? 1 : 0, w === 0 ? 1 : 0),
  },
  {
    id: 'sphere', name: 'Sphere', size: [2, 2, 2], lattice: [2, 2, 2],
    cells: (u, v, w) => octantState(u === 0 ? 1 : 0, v === 0 ? 1 : 0, w === 0 ? 1 : 0),
  },
];

export const SHAPE = Object.fromEntries(SHAPES.map((s) => [s.id, s]));

/**
 * A shape placed in the world: `rot` quarter turns (0: rises toward +z),
 * `flip` upside down (slopes and stairs against a ceiling). `origin` is the
 * world voxel at the footprint's minimum corner. `voxels` lists every voxel
 * it fills as [x, y, z, state].
 */
export function placement(shape, origin, rot = 0, flip = false) {
  // Only slopes and stairs have a facing; everything else is symmetric.
  if (!shape.oriented) { rot = 0; flip = false; }
  rot = ((rot % 4) + 4) % 4;
  const [lx, ly, lz] = shape.size;
  const size = rot % 2 ? [lz, ly, lx] : [lx, ly, lz];
  const toWorld = (u, v, w) => {
    let x, z;
    if (rot === 0) { x = u; z = w; }
    else if (rot === 1) { x = w; z = lx - 1 - u; }
    else if (rot === 2) { x = lx - 1 - u; z = lz - 1 - w; }
    else { x = lz - 1 - w; z = u; }
    const y = flip ? ly - 1 - v : v;
    return [origin[0] + x, origin[1] + y, origin[2] + z];
  };
  const voxels = [];
  for (let w = 0; w < lz; w++)
    for (let v = 0; v < ly; v++)
      for (let u = 0; u < lx; u++) {
        const st = shape.cells(u, v, w, rot, flip);
        if (st) voxels.push([...toWorld(u, v, w), st]);
      }
  return { shape, origin, rot, flip, size, voxels, toWorld };
}

/**
 * Quarter turns so that a slope rises away from a player looking along
 * (dx, dz).
 */
export function rotationForFacing(dx, dz) {
  if (Math.abs(dz) >= Math.abs(dx)) return dz >= 0 ? 0 : 2;
  return dx >= 0 ? 1 : 3;
}
