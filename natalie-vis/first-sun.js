// first-sun.js (v3)  ·  "When does the coast finally see the sun?"
// Requires d3 v7 loaded globally. Styles live in first-sun.css.
//
//   initFirstSun(rootElement, data, { basemap })
//   data     = { grid, hours, nDays, getFrame }   (see first-sun-data.js)
//   basemap  = GeoJSON FeatureCollection of US states (topojson.feature(us, us.objects.states))
//
// How the map works: for every screen pixel we interpolate the satellite grid smoothly, find the
// hour at which cloud chance first drops to the threshold (interpolating between hours too), and
// color that moment. Thin lines mark each whole hour.
//
// Performance notes (v3): satellite fields are resampled onto each map's pixel grid once, so moving the
// threshold slider only scans 12 numbers per cell; the coastline is drawn once to a cached layer; hovering
// only repaints a tiny overlay canvas and updates the existing inset SVG instead of rebuilding it.

const VIEWS = [
  {
    id: 'sf', name: 'San Francisco', lat: [37.35, 38.05], lon: [-122.9, -122.0],
    box: { lat: [37.60, 37.90], lon: [-122.55, -122.35] }
  },
  {
    id: 'sd', name: 'San Diego', lat: [32.45, 33.15], lon: [-117.6, -116.8],
    box: { lat: [32.65, 33.00], lon: [-117.30, -117.10] }
  },
];

// Early sun is warm yellow, late sun is deep indigo. Lightness falls steadily, so order is readable.
const PALETTE = ['#ffe27a', '#f6a55b', '#d65f78', '#6a3d92', '#24285f'];
const NEVER_LAND = [142, 152, 167];
const NEVER_WATER = [188, 196, 208];
const NO_DATA = [238, 240, 244];

function fmtTime(h) {
  let m = Math.round((h * 60) / 5) * 5;
  const hh = Math.floor(m / 60), mm = m % 60;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}
const fmtHour = h => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
const fmtDay = d => `June ${d + 1}`;
function fmtDur(min) {
  const m = Math.round(min / 5) * 5;
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

export function initFirstSun(root, data, opts = {}) {
  const { grid, hours, nDays, getFrame } = data;
  const nH = hours.length, nPix = grid.nLat * grid.nLon;
  const sunriseHour = opts.sunriseHour ?? 6;
  const sunriseIdx = Math.max(0, hours.findIndex(h => h >= sunriseHour));
  const hMin = hours[sunriseIdx], hMax = hours[nH - 1];
  const S = opts.resolution ?? 2;                         // screen px per field cell (smaller = sharper, slower)
  const CONTOUR_STEP = 2;                                 // hour lines are traced on every 2nd cell (still finer than the 3 km data)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // ---------- June-average cloud chance per pixel per hour ----------
  const avg = hours.map(() => new Float32Array(nPix));
  const cnt = hours.map(() => new Uint8Array(nPix));
  for (let d = 0; d < nDays; d++) {
    for (let h = 0; h < nH; h++) {
      const f = getFrame(d, h);
      for (let p = 0; p < nPix; p++) { const v = f[p]; if (v !== 255) { avg[h][p] += v; cnt[h][p]++; } }
    }
  }
  for (let h = 0; h < nH; h++) for (let p = 0; p < nPix; p++) avg[h][p] = cnt[h][p] ? avg[h][p] / cnt[h][p] : NaN;

  // ---------- color lookup (packed RGBA so a pixel is one 32-bit write) ----------
  const interp = d3.interpolateRgbBasis(PALETTE);
  const lut = Array.from({ length: 256 }, (_, i) => { const c = d3.rgb(interp(i / 255)); return [c.r, c.g, c.b]; });
  const pack = c => ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;   // little-endian RGBA
  const lut32 = Uint32Array.from(lut, pack);
  const C_NEVER_LAND = pack(NEVER_LAND), C_NEVER_WATER = pack(NEVER_WATER), C_NO_DATA = pack(NO_DATA);
  const colorIdx = v => Math.max(0, Math.min(255, Math.round(((v - hMin) / (hMax - hMin)) * 255)));

  // ---------- state ----------
  const state = { mode: 'day', thr: 0.5, day: opts.startDay ?? 13, hover: null };
  let dayField = null;                                    // raw satellite frames for the chosen day

  // ---------- DOM ----------
  root.classList.add('fs-root');
  root.innerHTML = `
    <div class="fs-controls">
      <div class="fs-seg" role="radiogroup" aria-label="Which mornings to show">
        <label><input type="radio" name="fs-mode" value="day" checked><span>Day by day</span></label>
        <label><input type="radio" name="fs-mode" value="avg"><span>June average</span></label>
      </div>
      <label class="fs-slider fs-thr" hidden>
        <span class="fs-slider-label">Sunny means cloud chance of at most <output>50%</output></span>
        <input type="range" min="10" max="90" step="5" value="50">
      </label>
      <label class="fs-slider fs-day">
        <span class="fs-slider-label">Pick a day in June: <output>${fmtDay(state.day)}</output></span>
        <input type="range" min="0" max="${nDays - 1}" step="1" value="${state.day}">
      </label>
    </div>
    <p class="fs-takeaway" aria-live="polite"></p>
    <div class="fs-maps"></div>
    <div class="fs-legend"></div>
    <div class="fs-inset" aria-live="polite"><p class="fs-hint">Hover a spot on either map to see what its morning looks like.</p></div>
    <p class="fs-note">Hours before sunrise (about 5:45 AM) are left out because the satellite is less reliable in the dark. The map is smoothed between satellite pixels (about 3 km each) for readability.</p>`;

  const mapsEl = root.querySelector('.fs-maps');
  const rootW = root.clientWidth || 940;
  const gap = 20;
  const W = rootW < 560 ? Math.max(260, rootW) : Math.max(260, Math.min(520, Math.floor((rootW - gap) / 2)));
  const panels = VIEWS.map(v => buildPanel(v, W));
  setDay(state.day);

  // ---------- panel construction ----------
  function buildPanel(view, W) {
    const corners = {
      type: 'MultiPoint', coordinates: [
        [view.lon[0], view.lat[0]], [view.lon[1], view.lat[0]], [view.lon[1], view.lat[1]], [view.lon[0], view.lat[1]]]
    };
    const projection = d3.geoMercator().fitWidth(W, corners);
    const H = Math.ceil(d3.geoPath(projection).bounds(corners)[1][1]);
    const fw = Math.ceil(W / S), fh = Math.ceil(H / S), n = fw * fh;

    const fig = document.createElement('figure');
    fig.className = 'fs-panel';
    fig.innerHTML = `
      <figcaption>
        <span class="fs-city">${view.name}</span>
        <span class="fs-big">–</span>
        <span class="fs-sub">typical first sun on the coast</span>
      </figcaption>
      <div class="fs-canvas-wrap"><canvas class="fs-data"></canvas><canvas class="fs-hover"></canvas><div class="fs-tip" hidden></div></div>`;
    mapsEl.appendChild(fig);
    const canvas = fig.querySelector('.fs-data'), hover = fig.querySelector('.fs-hover');
    for (const c of [canvas, hover]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.aspectRatio = `${W} / ${H}`; }
    const ctx = canvas.getContext('2d'), hctx = hover.getContext('2d');

    // land mask (rasterize basemap, sample)
    let landData = null;
    if (opts.basemap) {
      const off = document.createElement('canvas'); off.width = W; off.height = H;
      const octx = off.getContext('2d');
      octx.fillStyle = '#000'; octx.beginPath(); d3.geoPath(projection, octx)(opts.basemap); octx.fill();
      landData = octx.getImageData(0, 0, W, H).data;
    }
    const isLand = (x, y) => {
      if (!landData) return 1;
      const xi = Math.min(W - 1, Math.max(0, Math.round(x))), yi = Math.min(H - 1, Math.max(0, Math.round(y)));
      return landData[(yi * W + xi) * 4 + 3] > 0 ? 1 : 0;
    };

    // per field-cell sampling info
    const i0 = new Int32Array(n), j0 = new Int32Array(n), tx = new Float32Array(n), ty = new Float32Array(n);
    const ok = new Uint8Array(n), land = new Uint8Array(n);
    const [bx0, by1] = projection([view.box.lon[0], view.box.lat[0]]);
    const [bx1, by0] = projection([view.box.lon[1], view.box.lat[1]]);
    const boxCells = [];
    for (let sy = 0; sy < fh; sy++) for (let sx = 0; sx < fw; sx++) {
      const k = sy * fw + sx, x = (sx + 0.5) * S, y = (sy + 0.5) * S;
      const [lon, lat] = projection.invert([x, y]);
      const gx = (lon - grid.lon0) / grid.dlon - 0.5, gy = (lat - grid.lat0) / grid.dlat - 0.5;
      const ii = Math.floor(gy), jj = Math.floor(gx);
      if (ii < 0 || jj < 0 || ii >= grid.nLat - 1 || jj >= grid.nLon - 1) continue;
      i0[k] = ii; j0[k] = jj; tx[k] = gx - jj; ty[k] = gy - ii; ok[k] = 1;
      land[k] = isLand(x, y);
      if (land[k] && x >= bx0 && x <= bx1 && y >= by0 && y <= by1) boxCells.push(k);
    }

    // static overlay (coastline + measurement box): drawn once, then copied onto the map on every repaint
    const staticLayer = document.createElement('canvas'); staticLayer.width = canvas.width; staticLayer.height = canvas.height;
    {
      const sctx = staticLayer.getContext('2d'); sctx.scale(dpr, dpr);
      if (opts.basemap) {
        sctx.beginPath(); d3.geoPath(projection, sctx)(opts.basemap);
        sctx.strokeStyle = 'rgba(16,20,32,.85)'; sctx.lineWidth = 1.1; sctx.stroke();
      }
      sctx.setLineDash([5, 3]); sctx.strokeStyle = '#101420'; sctx.lineWidth = 1.4;
      sctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
    }

    const fieldCanvas = document.createElement('canvas'); fieldCanvas.width = fw; fieldCanvas.height = fh;
    const fctx = fieldCanvas.getContext('2d');
    const imgData = fctx.createImageData(fw, fh);
    const cw = Math.ceil(fw / CONTOUR_STEP), ch = Math.ceil(fh / CONTOUR_STEP);

    const pn = {
      view, W, H, fw, fh, n, cw, ch, projection, canvas, ctx, hover, hctx, i0, j0, tx, ty, ok, land,
      boxCells: Int32Array.from(boxCells), staticLayer, fieldCanvas, fctx, imgData, px32: new Uint32Array(imgData.data.buffer),
      vals: new Float32Array(n), cvals: new Float32Array(n), cvalsCoarse: new Float32Array(cw * ch),
      big: fig.querySelector('.fs-big'), sub: fig.querySelector('.fs-sub'), tip: fig.querySelector('.fs-tip'), median: NaN,
      avgR: null, dayR: null,
    };
    pn.avgR = resampleAll(avg, pn);                      // June-average fields on this map's grid (computed once)

    // pointer events: coalesced to one update per frame
    let pending = null;
    hover.addEventListener('pointermove', ev => {
      const r = hover.getBoundingClientRect();
      pending = { pn, cx: ev.clientX - r.left, cy: ev.clientY - r.top, rw: r.width, rh: r.height };
      scheduleHover();
    });
    hover.addEventListener('pointerleave', () => { pending = null; state.hover = null; pn.tip.hidden = true; pn.hctx.clearRect(0, 0, pn.hover.width, pn.hover.height); });
    pn.takePending = () => { const p = pending; pending = null; return p; };
    pn.hasPending = () => pending !== null;
    return pn;
  }

  // ---------- sampling & first-sun calculation ----------
  // Bilinear-resample one satellite field onto a panel's cell grid. Done once per field (not per
  // slider tick), so dragging the threshold only has to scan 12 numbers per cell.
  function resample(field, pn) {
    const { n, i0, j0, tx, ty, ok } = pn, nl = grid.nLon, out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (!ok[k]) { out[k] = NaN; continue; }
      const p = i0[k] * nl + j0[k], a = tx[k], b = ty[k];
      const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
      const v00 = field[p], v10 = field[p + 1], v01 = field[p + nl], v11 = field[p + nl + 1];
      let s = 0, ws = 0;
      if (v00 === v00) { s += v00 * w00; ws += w00; }
      if (v10 === v10) { s += v10 * w10; ws += w10; }
      if (v01 === v01) { s += v01 * w01; ws += w01; }
      if (v11 === v11) { s += v11 * w11; ws += w11; }
      out[k] = ws > 0.25 ? s / ws : NaN;
    }
    return out;
  }
  function resampleAll(fields, pn) { return fields.map(f => resample(f, pn)); }

  // First time (in fractional hours) the cloud chance drops to the threshold, or NaN if it never does.
  function firstSun(rs, thr, k) {
    let prev = NaN, prevH = -1;
    for (let h = sunriseIdx; h < nH; h++) {
      const v = rs[h][k];
      if (v === v && v <= thr) {
        if (h === sunriseIdx || prev !== prev) return hours[h];
        const t = (prev - thr) / (prev - v);
        return hours[prevH] + t * (hours[h] - hours[prevH]);
      }
      if (v === v) { prev = v; prevH = h; }
    }
    return NaN;
  }

  // ---------- which fields to use ----------
  const currentFields = pn => state.mode === 'avg' ? { rs: pn.avgR, thr: state.thr } : { rs: pn.dayR, thr: 0.5 };

  // ---------- render ----------
  function renderPanel(pn) {
    const { rs, thr } = currentFields(pn);
    const { n, vals, cvals, px32, ok, land, boxCells } = pn;
    const never = hMax + 2;
    for (let k = 0; k < n; k++) {
      if (!ok[k]) { vals[k] = NaN; cvals[k] = never; px32[k] = C_NO_DATA; continue; }
      const v = firstSun(rs, thr, k);
      vals[k] = v;
      if (v === v) { px32[k] = lut32[colorIdx(v)]; cvals[k] = v; }
      else { px32[k] = land[k] ? C_NEVER_LAND : C_NEVER_WATER; cvals[k] = never; }
    }
    pn.fctx.putImageData(pn.imgData, 0, 0);

    // hour lines, traced on a coarser grid (every CONTOUR_STEP-th cell)
    const { fw, fh, cw, ch, cvalsCoarse } = pn;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      cvalsCoarse[y * cw + x] = cvals[Math.min(fh - 1, y * CONTOUR_STEP) * fw + Math.min(fw - 1, x * CONTOUR_STEP)];
    }
    pn.contours = d3.contours().size([cw, ch]).thresholds(d3.range(hMin + 1, hMax + 1))(cvalsCoarse);

    // median first-sun time over the coastal-land box
    const bv = new Float64Array(boxCells.length);
    for (let i = 0; i < boxCells.length; i++) { const v = vals[boxCells[i]]; bv[i] = v === v ? v : Infinity; }
    bv.sort();
    pn.median = bv.length ? d3.quantileSorted(bv, 0.5) : NaN;
    pn.sub.textContent = state.mode === 'day' ? `first sun on the coast, ${fmtDay(state.day)}` : 'typical first sun on the coast';
    pn.big.textContent = pn.median !== pn.median ? '–' : (pn.median === Infinity ? 'after noon' : fmtTime(pn.median));
    paintPanel(pn);
  }

  // Repaints the map layer: colors, hour lines, cached coastline. Only runs when the data changes.
  function paintPanel(pn) {
    const { ctx, W, H, fw, fh } = pn;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pn.fieldCanvas, 0, 0, fw, fh, 0, 0, fw * S, fh * S);
    ctx.save();
    const m = S * CONTOUR_STEP;                                   // coarse cell -> screen px (cell centers line up)
    ctx.translate(-0.5 * S, -0.5 * S); ctx.scale(m, m);
    ctx.lineJoin = 'round'; ctx.lineWidth = 0.9 / m; ctx.strokeStyle = 'rgba(255,255,255,.7)';
    const path = d3.geoPath(null, ctx);
    ctx.beginPath(); for (const c of pn.contours) path(c); ctx.stroke();
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(pn.staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Hover ring lives on its own transparent canvas, so moving the mouse never repaints the map.
  function drawRing(h) {
    const { hctx, hover } = h.pn;
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, h.pn.W, h.pn.H);
    hctx.beginPath(); hctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
    hctx.strokeStyle = '#fff'; hctx.lineWidth = 3.5; hctx.stroke();
    hctx.strokeStyle = '#101420'; hctx.lineWidth = 1.5; hctx.stroke();
  }

  function showTip(pn, k, cx, cy) {
    const v = pn.vals[k];
    pn.tip.hidden = false;
    pn.tip.textContent = (v === v ? `Sun by ${fmtTime(v)}` : 'Still cloudy at noon') + (pn.land[k] ? '' : ' · open water');
    pn.tip.style.left = Math.min(cx + 14, pn.canvas.clientWidth - 150) + 'px';
    pn.tip.style.top = Math.max(0, cy - 34) + 'px';
  }

  function drawLegend() {
    const el = root.querySelector('.fs-legend');
    const stops = d3.range(0, 11).map(i => { const c = lut[Math.round((i / 10) * 255)]; return `rgb(${c[0]},${c[1]},${c[2]})`; });
    const ticks = d3.range(hMin, hMax + 1).map(h => {
      const pct = ((h - hMin) / (hMax - hMin)) * 100;
      return `<span style="left:${pct}%">${fmtHour(h).replace(' ', '')}</span>`;
    }).join('');
    el.innerHTML = `
      <div class="fs-scale">
        <div class="fs-bar" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
        <div class="fs-ticks">${ticks}</div>
        <div class="fs-scale-title">First sunny hour</div>
      </div>
      <div class="fs-keys">
        <span class="fs-key-item"><i class="fs-sw" style="background:rgb(${NEVER_LAND})"></i>still cloudy at noon</span>
        <span class="fs-key-item"><i class="fs-line"></i>each whole hour</span>
        <span class="fs-key-item"><i class="fs-dash"></i>coast used for the time above</span>
      </div>`;
  }

  // ---------- takeaway sentence built from the numbers ----------
  function writeTakeaway() {
    const el = root.querySelector('.fs-takeaway');
    const [a, b] = panels;
    if (a.median !== a.median || b.median !== b.median) { el.textContent = ''; return; }
    const when = state.mode === 'avg' ? 'On a typical June morning' : `On ${fmtDay(state.day)}`;
    if (a.median === Infinity && b.median === Infinity) { el.textContent = `${when}, neither coast has cleared by noon.`; return; }
    if (a.median === Infinity || b.median === Infinity) {
      const [stuck, clear] = a.median === Infinity ? [a, b] : [b, a];
      el.textContent = `${when}, ${stuck.view.name}'s coast is still mostly cloudy at noon, while ${clear.view.name}'s sees the sun by ${fmtTime(clear.median)}.`;
      return;
    }
    const diff = (b.median - a.median) * 60;
    if (Math.abs(diff) < 10) { el.textContent = `${when}, the two coasts see the sun at about the same time, around ${fmtTime((a.median + b.median) / 2)}.`; return; }
    const [early, late] = diff > 0 ? [a, b] : [b, a];
    el.textContent = `${when}, ${late.view.name}'s coast sees the sun about ${fmtDur(Math.abs(diff))} later than ${early.view.name}'s (${fmtTime(late.median)} versus ${fmtTime(early.median)}).`;
  }

  // ---------- hover inset: that spot's morning ----------
  // The SVG skeleton is built once; hovering only changes a few attributes, so there is no DOM rebuild.
  const inset = { el: root.querySelector('.fs-inset'), ready: false };
  const IW = 560, IH = 190, IM = { t: 14, r: 14, b: 28, l: 40 };
  const ix = d3.scaleLinear().domain([hours[0], hMax]).range([IM.l, IW - IM.r]);
  const iy = d3.scaleLinear().domain([0, 1]).range([IH - IM.b, IM.t]);
  const insetLine = d3.line().curve(d3.curveMonotoneX).defined(d => d.a === d.a).x(d => ix(d.hr)).y(d => iy(d.a));

  function buildInset() {
    inset.el.innerHTML = `
      <div class="fs-inset-head"><strong></strong><span class="fs-i-water"></span> · <span class="fs-i-when"></span>
        <span class="fs-muted fs-i-mode"></span></div>
      <svg viewBox="0 0 ${IW} ${IH}" role="img" aria-label="Chance of cloud by hour at the hovered spot">
        <rect x="${ix(hours[0])}" y="${IM.t}" width="${Math.max(0, ix(hMin) - ix(hours[0]))}" height="${IH - IM.b - IM.t}" class="fs-shade"/>
        <text x="${ix(hours[0]) + 4}" y="${IM.t + 12}" class="fs-svg-note">less reliable</text>
        ${[0, 0.5, 1].map(t => `<line x1="${IM.l}" x2="${IW - IM.r}" y1="${iy(t)}" y2="${iy(t)}" class="fs-grid"/>
          <text x="${IM.l - 6}" y="${iy(t) + 4}" text-anchor="end" class="fs-svg-tick">${t * 100}%</text>`).join('')}
        <g class="fs-i-thr"><line x1="${IM.l}" x2="${IW - IM.r}" class="fs-thr-line"/>
          <text x="${IW - IM.r}" text-anchor="end" class="fs-svg-note">sunny threshold</text></g>
        <path class="fs-avg-line"/>
        <path class="fs-day-line"/>
        <g class="fs-i-sun"><line y1="${IM.t}" y2="${IH - IM.b}" class="fs-sun-line"/><text y="${IH - IM.b - 6}" class="fs-svg-sun"></text></g>
        ${hours.filter((_, q) => q % 2 === 0).map(hr => `<text x="${ix(hr)}" y="${IH - 9}" text-anchor="middle" class="fs-svg-tick">${fmtHour(hr).replace(' ', '')}</text>`).join('')}
      </svg>
      <p class="fs-key-line"><i class="fs-sw-line fs-sw-avg"></i>share of June days cloudy at this hour
        <span class="fs-i-daykey"><i class="fs-sw-line fs-sw-day"></i>the selected day (1 = cloudy)</span></p>`;
    const q = s => inset.el.querySelector(s);
    Object.assign(inset, {
      ready: true, name: q('strong'), water: q('.fs-i-water'), when: q('.fs-i-when'), mode: q('.fs-i-mode'),
      thrG: q('.fs-i-thr'), thrLine: q('.fs-i-thr line'), thrText: q('.fs-i-thr text'),
      avgPath: q('.fs-avg-line'), dayPath: q('.fs-day-line'), dayKey: q('.fs-i-daykey'),
      sunG: q('.fs-i-sun'), sunLine: q('.fs-i-sun line'), sunText: q('.fs-i-sun text'),
    });
  }

  function drawInset() {
    if (!state.hover) return;
    if (!inset.ready) buildInset();
    const { pn, k } = state.hover;
    const v = pn.vals[k], thr = state.thr, isDay = state.mode === 'day';
    inset.name.textContent = pn.view.name;
    inset.water.textContent = pn.land[k] ? '' : ' · open water';
    inset.when.textContent = v === v ? `first sun ${fmtTime(v)}` : 'still cloudy at noon';
    inset.mode.textContent = `(${isDay ? fmtDay(state.day) : 'June typical'})`;
    inset.avgPath.setAttribute('d', insetLine(hours.map((hr, q) => ({ hr, a: pn.avgR[q][k] }))) || '');
    inset.dayPath.setAttribute('d', isDay ? (insetLine(hours.map((hr, q) => ({ hr, a: pn.dayR[q][k] }))) || '') : '');
    inset.dayPath.style.display = inset.dayKey.style.display = isDay ? '' : 'none';
    inset.thrG.style.display = isDay ? 'none' : '';
    if (!isDay) {
      inset.thrLine.setAttribute('y1', iy(thr)); inset.thrLine.setAttribute('y2', iy(thr));
      inset.thrText.setAttribute('x', IW - IM.r); inset.thrText.setAttribute('y', iy(thr) - 5);
    }
    inset.sunG.style.display = v === v ? '' : 'none';
    if (v === v) {
      inset.sunLine.setAttribute('x1', ix(v)); inset.sunLine.setAttribute('x2', ix(v));
      inset.sunText.setAttribute('x', Math.min(ix(v) + 6, IW - 70)); inset.sunText.textContent = fmtTime(v);
    }
  }

  // ---------- update loops (each coalesced to at most once per animation frame) ----------
  let queued = false;
  function recompute() {
    if (queued) return; queued = true;
    requestAnimationFrame(() => {
      queued = false;
      panels.forEach(renderPanel);
      writeTakeaway();
      if (state.hover) { refreshHover(); }
    });
  }

  let hoverQueued = false;
  function scheduleHover() {
    if (hoverQueued) return; hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      for (const pn of panels) {
        const p = pn.takePending(); if (!p) continue;
        const x = p.cx * (pn.W / p.rw), y = p.cy * (pn.H / p.rh);
        const k = Math.floor(y / S) * pn.fw + Math.floor(x / S);
        if (!(k >= 0 && k < pn.n) || !pn.ok[k]) continue;
        const changed = !state.hover || state.hover.pn !== pn || state.hover.k !== k;
        state.hover = { pn, k, x, y };
        drawRing(state.hover); showTip(pn, k, p.cx, p.cy);
        if (changed) drawInset();
      }
    });
  }
  function refreshHover() {                                   // data changed under a stationary pointer
    const h = state.hover; if (!h) return;
    showTip(h.pn, h.k, h.x * (h.pn.canvas.clientWidth / h.pn.W), h.y * (h.pn.canvas.clientHeight / h.pn.H));
    drawInset();
  }

  // ---------- day data ----------
  function setDay(day) {
    dayField = hours.map((_, h) => {
      const f = getFrame(day, h), o = new Float32Array(nPix);
      for (let p = 0; p < nPix; p++) o[p] = f[p] === 255 ? NaN : f[p];
      return o;
    });
    for (const pn of panels) pn.dayR = resampleAll(dayField, pn);
  }

  // ---------- controls ----------
  const thrWrap = root.querySelector('.fs-thr'), dayWrap = root.querySelector('.fs-day');
  root.querySelectorAll('input[name="fs-mode"]').forEach(r => r.addEventListener('change', e => {
    state.mode = e.target.value;
    thrWrap.hidden = state.mode !== 'avg'; dayWrap.hidden = state.mode !== 'day';
    recompute();
  }));
  thrWrap.querySelector('input').addEventListener('input', e => {
    state.thr = +e.target.value / 100;
    thrWrap.querySelector('output').textContent = e.target.value + '%'; recompute();
  });
  dayWrap.querySelector('input').addEventListener('input', e => {
    state.day = +e.target.value;
    dayWrap.querySelector('output').textContent = fmtDay(state.day);
    scheduleDay();
  });
  // day changes re-decode 12 satellite frames, so a fast drag only does the work for the latest value
  let dayQueued = false;
  function scheduleDay() {
    if (dayQueued) return; dayQueued = true;
    requestAnimationFrame(() => {
      dayQueued = false;
      setDay(state.day); opts.onDayChange?.(state.day); recompute();
    });
  }

  drawLegend();
  panels.forEach(renderPanel);
  writeTakeaway();

  return {
    showDay(d) {
      state.mode = 'day'; state.day = d; setDay(d);
      root.querySelector('input[value="day"]').checked = true;
      thrWrap.hidden = true; dayWrap.hidden = false;
      dayWrap.querySelector('input').value = d; dayWrap.querySelector('output').textContent = fmtDay(d);
      recompute();
    },
  };
}
