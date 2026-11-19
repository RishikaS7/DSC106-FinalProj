export async function loadFirstSunData(base = 'data/firstsun') {
  const [meta, buf] = await Promise.all([
    fetch(base + '.json').then(r => { if (!r.ok) throw new Error('missing ' + base + '.json'); return r.json(); }),
    fetch(base + '.bin').then(r => { if (!r.ok) throw new Error('missing ' + base + '.bin'); return r.arrayBuffer(); }),
  ]);
  const bytes = new Uint8Array(buf);
  const { grid, hours, nDays, bytesPerFrame } = meta;
  const nPix = grid.nLat * grid.nLon;

  function getFrame(day, h) {
    const off = (day * hours.length + h) * bytesPerFrame;
    const out = new Uint8Array(nPix);
    for (let p = 0; p < nPix; p++) {
      const code = (bytes[off + (p >> 2)] >> ((p & 3) * 2)) & 3;
      out[p] = code === 3 ? 255 : code;
    }
    return out;
  }
  return { grid, hours, nDays, getFrame, meta };
}
