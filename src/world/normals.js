/**
 * Unit normals packed into two bytes (octahedral encoding), for the
 * per-edge surface normals of the hermite data.
 */

const q = (v) => Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)));

/** Write the packed form of (x, y, z) (needn't be unit length) into out[at], out[at + 1]. */
export function packNormal(x, y, z, out, at) {
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l, v = z / l;
  if (y < 0) {
    const ou = u, ov = v;
    u = (1 - Math.abs(ov)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (ov >= 0 ? 1 : -1);
  }
  out[at] = q(u);
  out[at + 1] = q(v);
}

/** Unpack into out[0..2] (unit length). */
export function unpackNormal(a, b, out) {
  let u = (a / 255) * 2 - 1, v = (b / 255) * 2 - 1;
  let y = 1 - Math.abs(u) - Math.abs(v);
  if (y < 0) {
    const ou = u, ov = v;
    u = (1 - Math.abs(ov)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (ov >= 0 ? 1 : -1);
  }
  const l = Math.hypot(u, y, v) || 1;
  out[0] = u / l; out[1] = y / l; out[2] = v / l;
  return out;
}
