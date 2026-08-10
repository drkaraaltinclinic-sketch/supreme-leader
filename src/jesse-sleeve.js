'use strict';

/**
 * jesse-sleeve.js — JESSE sleeve: the two clean-risk CODEX cards adopted by
 * sovereign decision (Dr K, 2026-08-10), running in SHADOW mode first.
 *
 *   JESSE_BB  — CODEX #30 BBSqueezeTrend: 4h BB(29,1.82) inside Keltner(29,1.56)
 *               squeeze; fire after ≥4 bars persistence; direction = sign of
 *               linreg slope(11); ADX(14) ≥ 19.11; stop 1.74×ATR, trail 3.71×ATR.
 *   JESSE_STP — CODEX #26 ETHSTPullback30m: 4h SuperTrend(10,3.5)+EMA200 regime,
 *               30m SuperTrend(10,3) reclaim or trend-inception entry, ADX ≥ 24;
 *               stop 7×ATR(30m), chandelier trail 9×ATR, regime-flip liquidation,
 *               NO profit target (the right tail is the edge).
 *
 * SHADOW mode: signals are logged and a paper-shadow book is managed with each
 * card's own exit rules — no real (paper-book) positions are opened. Promotion
 * to live entries is JESSE_MODE=LIVE in Railway variables — no deploy needed.
 * Rollback likewise: JESSE_SLEEVE=OFF.
 */

const M30_MS = 30 * 60_000;
const H4_MS = 4 * 3600_000;

// ─── candles ─────────────────────────────────────────────────────────────────
async function fetchClosedBars(fetchImpl, hlApi, coin, interval, barMs, count) {
  const end = Date.now();
  const start = end - barMs * (count + 5);
  const res = await fetchImpl(hlApi, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`jesse candles ${coin} ${interval} http ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error(`jesse: no ${interval} candles for ${coin}`);
  const bars = rows.map(c => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
    .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  while (bars.length && Date.now() - bars[bars.length - 1].t < barMs) bars.pop(); // closed bars only
  return bars;
}

// ─── indicators (all return full series where needed) ────────────────────────
function emaSeries(vals, p) {
  const k = 2 / (p + 1), out = new Array(vals.length);
  let e = null;
  for (let i = 0; i < vals.length; i++) { e = e === null ? vals[i] : vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function smaStd(vals, p, i) { // SMA + population stdev of window ending at i
  const w = vals.slice(i - p + 1, i + 1);
  const m = w.reduce((a, b) => a + b, 0) / p;
  const v = w.reduce((a, b) => a + (b - m) * (b - m), 0) / p;
  return { mean: m, std: Math.sqrt(v) };
}
function trSeries(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : b.c;
    out.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return out;
}
function wilderSeries(vals, p) { // Wilder smoothing, seeded with simple average
  const out = new Array(vals.length).fill(null);
  if (vals.length < p) return out;
  let s = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = s;
  for (let i = p; i < vals.length; i++) { s = (s * (p - 1) + vals[i]) / p; out[i] = s; }
  return out;
}
function atrAt(bars, p, i) {
  const w = wilderSeries(trSeries(bars), p);
  return w[i == null ? bars.length - 1 : i];
}
function adxLast(bars, p) {
  if (bars.length < p * 2 + 2) return null;
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = wilderSeries(trSeries(bars), p), pS = wilderSeries(plusDM, p), mS = wilderSeries(minusDM, p);
  const dx = [];
  for (let i = 0; i < bars.length; i++) {
    if (tr[i] == null || !tr[i]) { dx.push(null); continue; }
    const pdi = 100 * pS[i] / tr[i], mdi = 100 * mS[i] / tr[i];
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  const clean = dx.filter(v => v != null);
  const adx = wilderSeries(clean, p);
  return adx[adx.length - 1];
}
function linregSlope(vals, p) {
  const w = vals.slice(-p), n = w.length;
  if (n < p) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += w[i]; sxy += i * w[i]; sx2 += i * i; }
  return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
}
function supertrendSeries(bars, p, factor) { // returns {line[], dir[]} — dir: +1/-1, line = active band
  const atrW = wilderSeries(trSeries(bars), p);
  const line = new Array(bars.length).fill(0), dir = new Array(bars.length).fill(0);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < bars.length; i++) {
    if (atrW[i] == null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    const bu = hl2 + factor * atrW[i], bl = hl2 - factor * atrW[i];
    fu = fu === null ? bu : (bu < fu || bars[i - 1].c > fu ? bu : fu);
    fl = fl === null ? bl : (bl > fl || bars[i - 1].c < fl ? bl : fl);
    if (bars[i].c > fu) d = 1; else if (bars[i].c < fl) d = -1;
    dir[i] = d; line[i] = d === 1 ? fl : fu;
  }
  return { line, dir };
}

// ─── JESSE_BB — CODEX #30 BBSqueezeTrend (4h) ────────────────────────────────
const BB = { period: 29, dev: 1.82, kcMult: 1.56, slopeP: 11, adxMin: 19.11, minSqueeze: 4, stopMult: 1.74, trailMult: 3.71 };

async function getBBSignal(fetchImpl, hlApi, coin) {
  const bars = await fetchClosedBars(fetchImpl, hlApi, coin, '4h', H4_MS, 220);
  if (bars.length < BB.period + BB.minSqueeze + 10) return { ready: false };
  const closes = bars.map(b => b.c);
  const kcMid = emaSeries(closes, BB.period);
  const atrKW = wilderSeries(trSeries(bars), BB.period);
  const sq = [];
  for (let i = BB.period - 1; i < bars.length; i++) {
    if (atrKW[i] == null) { sq.push(false); continue; }
    const { mean, std } = smaStd(closes, BB.period, i);
    const bbU = mean + BB.dev * std, bbL = mean - BB.dev * std;
    const kcU = kcMid[i] + BB.kcMult * atrKW[i], kcL = kcMid[i] - BB.kcMult * atrKW[i];
    sq.push(bbU < kcU && bbL > kcL);
  }
  const n = sq.length;
  const fired = n >= BB.minSqueeze + 2 && sq[n - 2] && !sq[n - 1] && sq.slice(n - 1 - BB.minSqueeze, n - 1).every(Boolean);
  const adx = adxLast(bars, 14);
  const slope = linregSlope(closes, BB.slopeP);
  const atrAbs = atrAt(bars, 14);
  const last = bars[bars.length - 1];
  const direction = fired && adx != null && adx >= BB.adxMin ? (slope > 0 ? 'LONG' : slope < 0 ? 'SHORT' : null) : null;
  return { ready: true, strategy: 'JESSE_BB', fired, direction, adx: adx != null ? +adx.toFixed(1) : null,
    slope, atrAbs, atrPct: +((100 * atrAbs) / last.c).toFixed(2), lastBarT: last.t, lastClose: last.c,
    stopMult: BB.stopMult, trailMult: BB.trailMult, minOffsetAtr: 0, regime: null };
}

// ─── JESSE_STP — CODEX #26 ETHSTPullback30m (30m/4h) ─────────────────────────
const STP = { anchorFactor: 3.5, stopAtr: 7.0, trailAtr: 9.0, adxMin: 24, inceptionBars: 7 };

async function getSTPSignal(fetchImpl, hlApi, coin) {
  const [a4, m30] = [
    await fetchClosedBars(fetchImpl, hlApi, coin, '4h', H4_MS, 800),
    await fetchClosedBars(fetchImpl, hlApi, coin, '30m', M30_MS, 300),
  ];
  if (a4.length < 250 || m30.length < 60) return { ready: false };
  const aCloses = a4.map(b => b.c);
  const ema200 = emaSeries(aCloses, 200);
  const st4 = supertrendSeries(a4, 10, STP.anchorFactor);
  // per-4h-bar regime series → bars since last change (inception window)
  const regimes = [];
  for (let i = 0; i < a4.length; i++) {
    if (!st4.line[i]) { regimes.push(0); continue; }
    const c = a4[i].c;
    regimes.push(c > st4.line[i] && c > ema200[i] ? 1 : c < st4.line[i] && c < ema200[i] ? -1 : 0);
  }
  const regime = regimes[regimes.length - 1];
  let since = 0;
  for (let i = regimes.length - 2; i >= 0 && regimes[i] === regime; i--) since++;
  const st30 = supertrendSeries(m30, 10, 3);
  const cl = m30.map(b => b.c), L = m30.length;
  const now = st30.line[L - 1] > 0 ? (cl[L - 1] > st30.line[L - 1] ? 1 : -1) : 0;
  const prev = st30.line[L - 2] > 0 ? (cl[L - 2] > st30.line[L - 2] ? 1 : -1) : 0;
  const adx = adxLast(m30, 14);
  const atrAbs = atrAt(m30, 14);
  const last = m30[L - 1];
  let direction = null;
  if (regime !== 0 && adx != null && adx >= STP.adxMin && now === regime) {
    const reclaimed = prev !== regime;
    const inception = since <= STP.inceptionBars;
    if (reclaimed || inception) direction = regime === 1 ? 'LONG' : 'SHORT';
  }
  return { ready: true, strategy: 'JESSE_STP', direction, regime, since, adx: adx != null ? +adx.toFixed(1) : null,
    atrAbs, atrPct: +((100 * atrAbs) / last.c).toFixed(2), lastBarT: last.t, lastClose: last.c,
    stopMult: STP.stopAtr, trailMult: STP.trailAtr, minOffsetAtr: 0.5 };
}

// ─── SHADOW BOOK — each card's own exits, no real positions ──────────────────
// shadow = { positions: [], trades: [] } (persisted by the agent)
function shadowOpen(shadow, sig, coin, px) {
  const d = sig.direction === 'LONG' ? 1 : -1;
  shadow.positions.push({
    strategy: sig.strategy, asset: coin, direction: sig.direction,
    entryPx: px, stopPx: px - d * sig.stopMult * sig.atrAbs,
    atrAbs: sig.atrAbs, trailMult: sig.trailMult, minOffsetAtr: sig.minOffsetAtr,
    peak: px, openedAt: new Date().toISOString(), barT: sig.lastBarT,
  });
}
function shadowManage(shadow, prices, regimeByStrategy) {
  const closed = [];
  for (const p of shadow.positions.slice()) {
    const px = prices[p.asset];
    if (!px) continue;
    const d = p.direction === 'LONG' ? 1 : -1;
    p.peak = d === 1 ? Math.max(p.peak, px) : Math.min(p.peak, px);
    let trail = d === 1
      ? Math.min(p.peak - p.trailMult * p.atrAbs, px - (p.minOffsetAtr || 0) * p.atrAbs)
      : Math.max(p.peak + p.trailMult * p.atrAbs, px + (p.minOffsetAtr || 0) * p.atrAbs);
    if (d === 1 && trail > p.stopPx) p.stopPx = trail;
    if (d === -1 && trail < p.stopPx) p.stopPx = trail;
    const regime = regimeByStrategy[p.strategy];
    const flip = p.strategy === 'JESSE_STP' && regime !== undefined && regime !== null && regime !== d;
    const hitStop = d === 1 ? px <= p.stopPx : px >= p.stopPx;
    if (hitStop || flip) {
      const exitPx = hitStop ? p.stopPx : px;
      const pnlPct = +(d * (exitPx - p.entryPx) / p.entryPx * 100).toFixed(3);
      const r = +((d * (exitPx - p.entryPx)) / (Math.abs(p.entryPx - (p.entryPx - d * p.trailMult * p.atrAbs)) || 1e-9)).toFixed(2);
      shadow.positions = shadow.positions.filter(x => x !== p);
      const t = { ...p, exitPx, closedAt: new Date().toISOString(), reason: hitStop ? 'TRAIL_STOP' : 'REGIME_FLIP', pnlPct, r };
      shadow.trades.unshift(t);
      shadow.trades = shadow.trades.slice(0, 200);
      closed.push(t);
    }
  }
  return closed;
}

module.exports = { getBBSignal, getSTPSignal, shadowOpen, shadowManage, BB, STP };
