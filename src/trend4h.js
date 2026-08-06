'use strict';

/**
 * trend4h.js — TREND4H entry engine: BTC-only, 4h EMA-cross trend following.
 *
 * The redesign candidate validated by CRUCIBLE assays #6 and #13
 * (BTC 4h 12/48 → PF 1.259 · BTC 4h 8/24 → PF 1.293, 365d real candles,
 * live management mechanics, conservative fees). Entries only — the live
 * stop/target/time-stop/trail management stack is untouched.
 *
 * Mechanics mirror the assayed CrucibleTrend template: when FLAT, be in the
 * market in the direction of the EMA state (fast>slow → LONG, fast<slow →
 * SHORT), evaluated on CLOSED 4h bars only. One action per closed bar.
 */

const H4_MS = 4 * 3600_000;

/** Pure signal computation over closed 4h candles (ascending [{t,o,h,l,c}]). */
function computeSignal(candles, fastP = 8, slowP = 24) {
  if (!Array.isArray(candles) || candles.length < slowP * 3) return { ready: false };
  const kF = 2 / (fastP + 1), kS = 2 / (slowP + 1);
  let fast = null, slow = null, prevDiff = null, dir = 0, crossAge = null;
  const trs = [];
  let prevClose = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    fast = fast === null ? c.c : c.c * kF + fast * (1 - kF);
    slow = slow === null ? c.c : c.c * kS + slow * (1 - kS);
    if (prevClose !== null) trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
    prevClose = c.c;
    if (i >= slowP) {
      const diff = fast - slow;
      if (diff !== 0) {
        if (prevDiff !== null && Math.sign(diff) !== Math.sign(prevDiff)) crossAge = 0;
        else if (crossAge !== null) crossAge++;
        dir = diff > 0 ? 1 : -1;
        prevDiff = diff;
      }
    }
  }
  const n = Math.min(14, trs.length);
  const atr = n ? trs.slice(-n).reduce((a, b) => a + b, 0) / n : 0;
  const last = candles[candles.length - 1];
  return {
    ready: true,
    direction: dir > 0 ? 'LONG' : dir < 0 ? 'SHORT' : null,
    crossAge,
    atrPct: last.c > 0 ? +((100 * atr) / last.c).toFixed(2) : null,
    fast, slow, lastClose: last.c, lastBarT: last.t,
  };
}

/** Fetch closed BTC 4h candles from Hyperliquid and compute the signal. */
async function getSignal(fetchImpl, hlApi, { fastP = 8, slowP = 24 } = {}) {
  const end = Date.now();
  const start = end - H4_MS * (slowP * 3 + 40);
  const res = await fetchImpl(hlApi, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '4h', startTime: start, endTime: end } }),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`trend4h candles http ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('trend4h: no candles');
  const bars = rows.map((c) => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t);
  // Drop the still-forming bar: closed bars only, like the assay.
  while (bars.length && Date.now() - bars[bars.length - 1].t < H4_MS) bars.pop();
  return computeSignal(bars, fastP, slowP);
}

module.exports = { computeSignal, getSignal, H4_MS };
