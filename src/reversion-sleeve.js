'use strict';

/**
 * reversion-sleeve.js — ETH-REVERSION sleeve, adopted by sovereign decision
 * (Dr K, 2026-08-28) into SHADOW probation.
 *
 * This is a live mirror of the Crucible's crucible_reversion template — the
 * second-sleeve candidate proven in assays #49 (90d PF 1.247), #50 (180d
 * 1.189) and #54 (~208d max-window 1.11; HL caps 1h history at 5000 bars):
 *
 *   REGIME GATE: trade only ranging tape — |EMA12 − EMA48| / close × 100
 *                must be < 0.75. Trending tape is untouchable.
 *   ENTRY:       RSI(14) ≤ 30 → LONG (buy fear); RSI(14) ≥ 70 → SHORT.
 *   MANAGEMENT:  stop 1.5×ATR(14), target 2R, time stop 72 bars, evaluated
 *                at 1h bar close — identical to the assayed mechanics, so the
 *                shadow ledger is directly comparable to the assay evidence.
 *
 * SHADOW ONLY: signals open paper-shadow positions — the real (paper) book is
 * never touched, and no live entry path exists in this module or its wiring.
 * Promotion to the live paper book is a separate SOVEREIGN patch (Dr K's hand),
 * never an env flip. Kill switch: REVERSION_SLEEVE=OFF.
 */

const H1_MS = 3600_000;

const CFG = { fast: 12, slow: 48, bandPct: 0.75, rsiP: 14, rsiBuy: 30, rsiSell: 70,
  atrP: 14, stopMult: 1.5, targetR: 2.0, maxHoldBars: 72, allowShorts: true };

async function fetchClosedBars(fetchImpl, hlApi, coin, count) {
  const end = Date.now();
  const start = end - H1_MS * (count + 5);
  const res = await fetchImpl(hlApi, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: start, endTime: end } }),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`reversion candles ${coin} http ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error(`reversion: no 1h candles for ${coin}`);
  const bars = rows.map(c => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
    .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  while (bars.length && Date.now() - bars[bars.length - 1].t < H1_MS) bars.pop(); // closed bars only
  return bars;
}

function emaLast(vals, p) {
  const k = 2 / (p + 1);
  let e = null;
  for (const v of vals) e = e === null ? v : v * k + e * (1 - k);
  return e;
}
function rsiLast(closes, p) { // Wilder RSI, matches the assay engine's convention
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  if (!l) return 100;
  return 100 - 100 / (1 + g / l);
}
function atrLast(bars, p) { // Wilder ATR
  if (bars.length < p + 1) return null;
  const tr = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : b.c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = tr.slice(0, p).reduce((s, v) => s + v, 0) / p;
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}

// Evaluate the latest closed 1h bar. Always returns diagnostics; direction is
// non-null only when the regime gate admits AND RSI is at an extreme.
function evaluate(bars) {
  if (bars.length < CFG.slow + CFG.rsiP + 10) return { ready: false };
  const closes = bars.map(b => b.c);
  const last = bars[bars.length - 1];
  const fast = emaLast(closes, CFG.fast), slow = emaLast(closes, CFG.slow);
  const band = Math.abs(fast - slow) / last.c * 100;
  const rsi = rsiLast(closes, CFG.rsiP);
  const atr = atrLast(bars, CFG.atrP);
  let direction = null;
  const gateOpen = band < CFG.bandPct;
  if (gateOpen && atr > 0 && rsi != null) {
    if (rsi <= CFG.rsiBuy) direction = 'LONG';
    else if (CFG.allowShorts && rsi >= CFG.rsiSell) direction = 'SHORT';
  }
  return { ready: true, strategy: 'REVERSION1H', direction, gateOpen,
    band: +band.toFixed(3), rsi: rsi != null ? +rsi.toFixed(1) : null,
    atrAbs: atr, lastBarT: last.t, lastClose: last.c };
}

function shadowOpen(shadow, sig, coin) {
  const d = sig.direction === 'LONG' ? 1 : -1;
  const risk = CFG.stopMult * sig.atrAbs;
  shadow.positions.push({
    strategy: 'REVERSION1H', asset: coin, direction: sig.direction,
    entryPx: sig.lastClose, stopPx: sig.lastClose - d * risk,
    targetPx: sig.lastClose + d * risk * CFG.targetR,
    barsHeld: 0, lastManagedT: sig.lastBarT,
    openedAt: new Date().toISOString(), barT: sig.lastBarT,
  });
}

// Bar-close management, identical to the assay template: walk each closed bar
// once; stop/target compare the CLOSE (not intrabar), time stop at 72 bars.
function shadowManage(shadow, bars) {
  const closed = [];
  for (const p of shadow.positions.slice()) {
    if (p.strategy !== 'REVERSION1H') continue;
    const d = p.direction === 'LONG' ? 1 : -1;
    for (const b of bars) {
      if (b.t <= p.lastManagedT) continue;
      p.lastManagedT = b.t;
      p.barsHeld += 1;
      const hitStop = d === 1 ? b.c <= p.stopPx : b.c >= p.stopPx;
      const hitTarget = d === 1 ? b.c >= p.targetPx : b.c <= p.targetPx;
      const timeUp = p.barsHeld >= CFG.maxHoldBars;
      if (hitStop || hitTarget || timeUp) {
        const exitPx = b.c;
        const pnlPct = +(d * (exitPx - p.entryPx) / p.entryPx * 100).toFixed(3);
        const risk = Math.abs(p.entryPx - p.stopPx) || 1e-9;
        const r = +((d * (exitPx - p.entryPx)) / risk).toFixed(2);
        shadow.positions = shadow.positions.filter(x => x !== p);
        const t = { ...p, exitPx, closedAt: new Date().toISOString(),
          reason: hitTarget ? 'TARGET' : hitStop ? 'STOP' : 'TIME_STOP', pnlPct, r };
        shadow.trades.unshift(t);
        shadow.trades = shadow.trades.slice(0, 200);
        closed.push(t);
        break;
      }
    }
  }
  return closed;
}

module.exports = { fetchClosedBars, evaluate, shadowOpen, shadowManage, CFG };
