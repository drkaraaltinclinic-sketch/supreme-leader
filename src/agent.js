/**
 * 👑 SUPREME LEADER — The Throne
 * Autonomous trading decision engine. PAPER MODE — every trade simulated with
 * real prices, fees and slippage until the graduation criteria are met:
 *   ≥30 trades · PF > 1.2 · drawdown inside budget · ≥21 days · vetoes proven.
 *
 * THE CONSTITUTION (ratified):
 *  Candidates  ← ENGINE verdicts + STRATEGOS blueprints + KAISEN bus signals
 *  Tier 1      ← ABSOLUTE vetoes (facts): risk budget, event risk, same-side
 *                crowding extreme, execution sanity, venue health, unlock alerts
 *  Tier 2      ← WEIGHTED conviction: signal + macro + mood + contrarian +
 *                relative strength + blueprint backing → sizes the position
 *  VIZIER      ← final IC review: CONCUR | ½ size | OBJECT (asymmetric, fail-open)
 *  Management  ← deterministic only: ATR stop · 2R target · time stop ·
 *                breakeven at +1R then ATR trail · Tier-1 fact changes close
 *  HERALD      ← Gmail reports: daily digest, trade alerts, critical alerts
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3023;
const GECKO_URL = process.env.GECKO_URL || 'wss://gecko-01-agent-production.up.railway.app/?agent=SUPREME-LEADER';
const HL_API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const START_BUDGET = parseFloat(process.env.START_BUDGET || '100');
const RISK_PCT = parseFloat(process.env.RISK_PCT || '1.0');           // % equity per trade
const CONVICTION_MIN = parseFloat(process.env.CONVICTION_MIN || '4');
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '4');
const MAX_NEW_PER_DAY = parseInt(process.env.MAX_NEW_PER_DAY || '3');
const MAX_LEV = parseFloat(process.env.MAX_LEV || '3');
const NET_DELTA_CAP = parseFloat(process.env.NET_DELTA_CAP || '1.5'); // × equity
const ATR_STOP_MULT = parseFloat(process.env.ATR_STOP_MULT || '1.5');
const TARGET_R = parseFloat(process.env.TARGET_R || '2');
const MAX_HOLD_H = parseFloat(process.env.MAX_HOLD_H || '72');
const FEE_BPS = parseFloat(process.env.FEE_BPS || '3.5');             // per side
const SLIP_BPS = parseFloat(process.env.SLIP_BPS || '5');             // adverse per side
const MIN_VOL_USD = parseFloat(process.env.MIN_VOL_USD || '10000000');
const MIN_OI_USD = parseFloat(process.env.MIN_OI_USD || '5000000');
const DECISION_MS = parseInt(process.env.DECISION_MS || '900000');    // 15 min
const MANAGE_MS = parseInt(process.env.MANAGE_MS || '60000');         // 1 min
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'ALL').toUpperCase(); // ALL | CURATED
const ENTRY_SCORE = parseFloat(process.env.ENTRY_SCORE || '3');
const STATE_DIR = process.env.STATE_DIR || (fs.existsSync('/data') ? '/data' : './data');
// HERALD
const EMAIL_TO = process.env.EMAIL_TO || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const EMAIL_TRADES = (process.env.EMAIL_TRADES || 'true') === 'true';
const DIGEST_HOUR_UTC = parseInt(process.env.DIGEST_HOUR_UTC || '6');

const SIBLINGS = {
  ENGINE: 'https://engine-01-agent-production.up.railway.app',
  MATRIX: 'https://matrix-01-agent-production.up.railway.app',
  SENTINEL: 'https://sentinel-01-agent-production.up.railway.app',
  CROWD: 'https://crowd-01-agent-production.up.railway.app',
  DEPTH: 'https://depth-01-agent-production.up.railway.app',
  SHERLOCK: 'https://sherlock-01-agent-production.up.railway.app',
  STRATEGOS: 'https://strategos-01-agent-production.up.railway.app',
  VIZIER: 'https://vizier-01-agent-production.up.railway.app',
};
(process.env.AGENT_URLS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
  const [k, ...rest] = pair.split('=');
  if (k && rest.length) SIBLINGS[k.trim().toUpperCase()] = rest.join('=').trim().replace(/\/$/, '');
});

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  startTime: Date.now(), bornAt: Date.now(), geckoConnected: false, paused: false,
  mode: 'PAPER',
  equity: START_BUDGET, realized: 0, fees: 0, peakEquity: START_BUDGET, maxDrawdownPct: 0,
  positions: [],       // open
  trades: [],          // closed (newest first)
  decisions: [],       // court record (newest first, 200)
  posSeq: 0, decSeq: 0,
  vetoCounts: {}, todayOpens: 0, todayKey: '',
  snapshot: {}, recentAlerts: [],
  prices: {}, meta: {},          // coin → {px, volUsd, oiUsd}
  siblingStatus: {},
  cycleCount: 0, lastCycleAt: null, lastDigestKey: '',
  emailsSent: 0, emailErrors: 0,
  errors: [], lastError: null,
};

function reportError(msg){ if(state.lastError===msg)return; state.lastError=msg;
  state.errors.push({time:new Date().toISOString(),message:msg}); state.errors=state.errors.slice(-12);
  emit('ERROR','supreme.error',{message:msg},'HIGH'); }

// ─── Persistence (survives restarts; add a Railway Volume at /data to survive redeploys) ──
function saveState() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const snap = { bornAt: state.bornAt, equity: state.equity, realized: state.realized, fees: state.fees,
      peakEquity: state.peakEquity, maxDrawdownPct: state.maxDrawdownPct,
      positions: state.positions, trades: state.trades.slice(0, 300), decisions: state.decisions.slice(0, 200),
      posSeq: state.posSeq, decSeq: state.decSeq, vetoCounts: state.vetoCounts };
    fs.writeFileSync(path.join(STATE_DIR, 'throne.json'), JSON.stringify(snap));
  } catch (e) {}
}
function loadState() {
  try {
    const p = path.join(STATE_DIR, 'throne.json');
    if (!fs.existsSync(p)) return;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    Object.assign(state, s);
    console.log(`[BOOT] Restored ledger: equity $${s.equity?.toFixed(2)} · ${s.trades?.length || 0} trades · ${s.positions?.length || 0} open`);
  } catch (e) { console.log('[BOOT] Fresh ledger'); }
}
loadState();
// One-time backfill: positions opened by the pre-patch code have no thesisTag field. Reconstruct
// it from their stored fearGreed vote so the thesis-cluster cap accounts for the existing book,
// not only trades opened after this deploy.
(function backfillThesisTags() {
  let n = 0;
  state.positions.forEach(p => {
    if (p.thesisTag === undefined || p.thesisTag === null) {
      const tag = thesisTagFromVotes(p.direction, p.votes);
      if (tag) { p.thesisTag = tag; n++; }
    }
  });
  if (n) console.log(`[BOOT] Backfilled thesisTag on ${n} pre-existing position(s)`);
})();
setInterval(saveState, 60000);

// ─── HERALD: raw Gmail SMTP (no dependencies) ─────────────────────────────────
function sendEmail(subject, html) {
  return new Promise((resolve) => {
    if (!EMAIL_TO || !EMAIL_FROM || !GMAIL_APP_PASSWORD) return resolve(false);
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});
    let step = 0, buf = '';
    const b64 = s => Buffer.from(s).toString('base64');
    const body = [
      `From: SUPREME LEADER <${EMAIL_FROM}>`, `To: ${EMAIL_TO}`,
      `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
      html, '.',
    ].join('\r\n');
    const steps = [
      { expect: '220', send: `EHLO throne.local` },
      { expect: '250', send: `AUTH LOGIN` },
      { expect: '334', send: b64(EMAIL_FROM) },
      { expect: '334', send: b64(GMAIL_APP_PASSWORD) },
      { expect: '235', send: `MAIL FROM:<${EMAIL_FROM}>` },
      { expect: '250', send: `RCPT TO:<${EMAIL_TO}>` },
      { expect: '250', send: `DATA` },
      { expect: '354', send: body },
      { expect: '250', send: `QUIT` },
      { expect: '221', send: null },
    ];
    const fail = (why) => { state.emailErrors++; reportError('HERALD: ' + why); try { sock.destroy(); } catch(e){} resolve(false); };
    const timer = setTimeout(() => fail('smtp timeout'), 30000);
    sock.on('data', d => {
      buf += d.toString();
      if (!buf.includes('\n')) return;
      const line = buf; buf = '';
      const st = steps[step];
      if (!st) return;
      if (!line.startsWith(st.expect)) return fail(`expected ${st.expect}, got: ${line.slice(0, 60)}`);
      step++;
      const next = steps[step - 1].send;
      if (next != null) sock.write(next + '\r\n');
      if (step >= steps.length) { clearTimeout(timer); state.emailsSent++; try { sock.end(); } catch(e){} resolve(true); }
    });
    sock.on('error', e => fail(e.message));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt$ = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const nowIso = () => new Date().toISOString();
async function hl(body) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 15000 });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  return res.json();
}
async function pull(name, pathSuffix) {
  try {
    const res = await fetch(SIBLINGS[name] + pathSuffix, { timeout: 12000 });
    if (!res.ok) throw new Error(res.status);
    state.siblingStatus[name] = 'OK';
    return await res.json();
  } catch (e) { state.siblingStatus[name] = 'UNREACHABLE'; return null; }
}
function unrealized(pos, px) {
  const d = pos.direction === 'LONG' ? 1 : -1;
  return d * (px - pos.entryPx) / pos.entryPx * pos.notional;
}
function rNow(pos, px) {
  const d = pos.direction === 'LONG' ? 1 : -1;
  return d * (px - pos.entryPx) / (pos.riskDist || 1e-9);
}
function equityNow() {
  let u = 0;
  state.positions.forEach(p => { const px = state.prices[p.asset]; if (px) u += unrealized(p, px); });
  return START_BUDGET + state.realized + u;
}
// THESIS TAG: identifies concurrent trades that share the SAME macro bet across DIFFERENT
// assets (e.g. "extreme fear, buy the dip" expressed via BTC, UNI and AAVE at once) — a pattern
// MATRIX's price-correlation clustering does not catch, since these assets needn't be correlated.
function thesisTagFor(direction, fng) {
  if (fng == null) return null;
  if (direction === 'LONG' && fng <= 30) return 'CONTRARIAN_FEAR_LONG';
  if (direction === 'SHORT' && fng >= 70) return 'CONTRARIAN_GREED_SHORT';
  return null;
}
// Reconstructs the same tag for positions opened by pre-patch code, which have no thesisTag field
// but DO have their votes.fearGreed saved. Note: votes.fearGreed was computed at the tighter ±25/75
// band (not thesisTagFor's ±30/70), so this backfill is a strict subset — it will not retroactively
// tag a legacy position opened at, say, fng=28. Good enough to close most of the gap without needing
// the original raw fng value, which was never stored on the position.
function thesisTagFromVotes(direction, votes) {
  if (!votes || votes.fearGreed == null) return null;
  if (direction === 'LONG' && votes.fearGreed === 1) return 'CONTRARIAN_FEAR_LONG';
  if (direction === 'SHORT' && votes.fearGreed === 1) return 'CONTRARIAN_GREED_SHORT';
  return null;
}

// ─── Prices ───────────────────────────────────────────────────────────────────
async function refreshPrices() {
  try {
    const [meta, ctxs] = await hl({ type: 'metaAndAssetCtxs' });
    meta.universe.forEach((u, i) => {
      const c = ctxs[i] || {};
      const px = parseFloat(c.markPx || 0);
      if (px > 0 && !u.isDelisted) {
        state.prices[u.name] = px;
        state.meta[u.name] = { volUsd: parseFloat(c.dayNtlVlm || 0), oiUsd: parseFloat(c.openInterest || 0) * px, fundingApr: parseFloat(c.funding || 0) * 24 * 365 * 100 };
      }
    });
  } catch (e) { reportError('prices: ' + e.message); }
}

// ─── Bus ear ──────────────────────────────────────────────────────────────────
function ingest(msg) {
  let id = msg.agentId, stats = null;
  if (msg.topic === 'gecko.agent.status' && msg.data?.agentId) { id = msg.data.agentId; stats = msg.data.stats; }
  else if (msg.type === 'STATUS') stats = msg.stats;
  if (!id || id === 'SUPREME-LEADER') return;
  if (stats) state.snapshot[id] = { stats, at: Date.now() };
  if (msg.type === 'ALERT' || /alert/i.test(msg.topic || '')) {
    state.recentAlerts.unshift({ t: Date.now(), agent: id, topic: msg.topic, data: msg.data || {} });
    state.recentAlerts = state.recentAlerts.slice(0, 150);
  }
}
function recentAlert(pred, windowMs) {
  const cut = Date.now() - windowMs;
  return state.recentAlerts.find(a => a.t >= cut && pred(a));
}

// ─── THE DECISION CYCLE ───────────────────────────────────────────────────────
function record(decision) {
  state.decSeq++;
  const d = { id: state.decSeq, at: nowIso(), ...decision };
  state.decisions.unshift(d);
  state.decisions = state.decisions.slice(0, 200);
  emit('DECISION', 'supreme.decision', d);
  return d;
}

async function decisionCycle() {
  if (state.paused) return;
  state.cycleCount++;
  state.lastCycleAt = nowIso();
  const dayKey = new Date().toISOString().slice(0, 10);
  if (state.todayKey !== dayKey) { state.todayKey = dayKey; state.todayOpens = 0; }
  emit('SYS', 'supreme.cycle.start', { cycle: state.cycleCount });
  try {
    await refreshPrices();
    // ── Gather intelligence ──
    const [engine, crowd, matrix, sentinel, depth, sherlockCal, strategos] = [
      await pull('ENGINE', '/reports'), await pull('CROWD', '/crowd'), await pull('MATRIX', '/field'),
      await pull('SENTINEL', '/watch'), await pull('DEPTH', '/depth'), await pull('SHERLOCK', '/calendar'),
      await pull('STRATEGOS', '/blueprints'),
    ];
    const engineReports = Object.values(engine?.reports || {});
    const crowdAssets = crowd?.assets || {};
    const rsOf = {}; (matrix?.assets || []).forEach(a => rsOf[a.coin] = a);
    const clusters = (matrix?.clusters || []).filter(c => c.size > 1).map(c => c.members);
    const venueHealth = sentinel?.venue?.health || 'HEALTHY';
    const fng = sentinel?.pulse?.fng;
    const volRegime = sentinel?.vola?.regime;
    const depthBooks = depth?.books || {};
    const macroStats = state.snapshot['MACRO-01']?.stats || {};
    const sherlockStats = state.snapshot['SHERLOCK-01']?.stats || {};

    // ── Global Tier-1: venue ──
    if (venueHealth === 'DEGRADED') {
      record({ asset: 'ALL', direction: '—', source: 'GLOBAL', action: 'VETOED', vetoes: ['VENUE_DEGRADED'], note: 'No new entries while the casino wobbles' });
      state.vetoCounts.VENUE_DEGRADED = (state.vetoCounts.VENUE_DEGRADED || 0) + 1;
      emit('SYS', 'supreme.cycle.complete', { cycle: state.cycleCount, evaluated: 0, executed: 0, note: 'venue degraded' });
      return;
    }
    // High-impact USD event within 12h?
    const eventSoon = (sherlockCal?.upcoming || []).find(e => e.impact === 'High' && e.country === 'USD' && e.ts > Date.now() && e.ts < Date.now() + 12 * 3600000);

    // ── Candidates ──
    const candidates = [];
    engineReports.filter(r => r.tf === '4h' && Math.abs(r.score) >= ENTRY_SCORE).forEach(r => {
      candidates.push({ asset: r.coin, direction: r.score > 0 ? 'LONG' : 'SHORT', source: 'ENGINE', engineScore: r.score, atrPct: r.atrPct, rationale: `ENGINE ${r.verdict} ${r.score}` });
    });
    (strategos?.blueprints || []).filter(b => b.status !== 'RETIRED' && (STRATEGY_MODE === 'ALL' || b.status === 'APPROVED')).forEach(bp => {
      (bp.legs || []).forEach(leg => {
        if (!candidates.find(c => c.asset === leg.asset && c.direction === leg.side)) {
          const er = engineReports.find(r => r.coin === leg.asset);
          candidates.push({ asset: leg.asset, direction: leg.side, source: `BLUEPRINT#${bp.id}`, blueprint: bp.name, bpApproved: bp.status === 'APPROVED', engineScore: er?.score ?? 0, atrPct: er?.atrPct, rationale: bp.name });
        } else {
          const c = candidates.find(c => c.asset === leg.asset && c.direction === leg.side);
          c.blueprint = bp.name; c.bpApproved = bp.status === 'APPROVED';
        }
      });
    });
    const kaisenAlert = recentAlert(a => a.agent === 'KAISEN-01' && a.data?.asset, DECISION_MS * 2);
    if (kaisenAlert && kaisenAlert.data.asset) {
      const dir = /BULL|LONG/i.test(JSON.stringify(kaisenAlert.data)) ? 'LONG' : /BEAR|SHORT/i.test(JSON.stringify(kaisenAlert.data)) ? 'SHORT' : null;
      if (dir && !candidates.find(c => c.asset === kaisenAlert.data.asset && c.direction === dir)) {
        const er = engineReports.find(r => r.coin === kaisenAlert.data.asset);
        candidates.push({ asset: kaisenAlert.data.asset, direction: dir, source: 'KAISEN', engineScore: er?.score ?? 0, atrPct: er?.atrPct, rationale: 'KAISEN bus signal' });
      }
    }

    let executed = 0;
    for (const cand of candidates.slice(0, 12)) {
      if (state.positions.length >= MAX_POSITIONS) break;
      if (state.todayOpens >= MAX_NEW_PER_DAY) break;
      if (state.positions.find(p => p.asset === cand.asset)) continue;
      const px = state.prices[cand.asset];
      const m = state.meta[cand.asset];
      if (!px || !m) continue;

      // ── TIER 1: ABSOLUTE VETOES ──
      const vetoes = [];
      const eq = equityNow();
      if (m.volUsd < MIN_VOL_USD || m.oiUsd < MIN_OI_USD) vetoes.push('EXECUTION_SANITY(thin market)');
      const db = depthBooks[cand.asset];
      if (db && db.band === 'THIN') vetoes.push('DEPTH_THIN');
      const ca = crowdAssets[cand.asset];
      if (ca && ca.crowding >= 70 && ((ca.side === 'LONG_CROWDED' && cand.direction === 'LONG') || (ca.side === 'SHORT_CROWDED' && cand.direction === 'SHORT'))) vetoes.push('SAME_SIDE_CROWDING_EXTREME');
      if (eventSoon) vetoes.push(`EVENT_RISK(${eventSoon.title} in ${((eventSoon.ts - Date.now()) / 3600000).toFixed(1)}h)`);
      if (cand.direction === 'LONG' && recentAlert(a => a.agent === 'TOKENOMIST-01' && JSON.stringify(a.data).includes(cand.asset), 5 * 86400000)) vetoes.push('UNLOCK_WINDOW');
      // Book: cluster cap (max 2 per cluster) + net delta cap
      const cluster = clusters.find(c => c.includes(cand.asset));
      if (cluster && state.positions.filter(p => cluster.includes(p.asset)).length >= 2) vetoes.push('CLUSTER_CAP');
      // Thesis cluster: with only MAX_POSITIONS(4) slots, 2-3 concurrent contrarian-fear (or
      // contrarian-greed) longs/shorts across unrelated tickers can fill most of the book on one bet.
      const thesisTag = thesisTagFor(cand.direction, fng);
      const sameThesisOpen = thesisTag ? state.positions.filter(p => p.thesisTag === thesisTag).length : 0;
      if (thesisTag && sameThesisOpen >= 2) vetoes.push('THESIS_CLUSTER_CAP');
      const netDelta = state.positions.reduce((s, p) => s + (p.direction === 'LONG' ? 1 : -1) * p.notional, 0);
      const dSign = cand.direction === 'LONG' ? 1 : -1;
      if (Math.sign(netDelta) === dSign && Math.abs(netDelta) >= eq * NET_DELTA_CAP) vetoes.push('NET_DELTA_CAP');

      if (vetoes.length) {
        vetoes.forEach(v => { const k = v.split('(')[0]; state.vetoCounts[k] = (state.vetoCounts[k] || 0) + 1; });
        record({ asset: cand.asset, direction: cand.direction, source: cand.source, action: 'VETOED', vetoes, rationale: cand.rationale });
        continue;
      }

      // ── TIER 2: CONVICTION ──
      const dir = cand.direction === 'LONG' ? 1 : -1;
      const votes = {};
      votes.signal = Math.max(0, Math.min(5, dir * (cand.engineScore || 0)));
      votes.blueprint = cand.blueprint ? (cand.bpApproved ? 1.5 : 1) : 0;
      const regime = (macroStats.regime || '').toUpperCase();
      votes.macro = /RISK_ON|BULL/.test(regime) ? 2 * dir : /RISK_OFF|BEAR/.test(regime) ? -2 * dir : 0;
      const mood = (sherlockStats.mood || '').toUpperCase();
      votes.mood = mood === 'BULLISH' ? 1 * dir : mood === 'BEARISH' ? -1 * dir : 0;
      votes.contrarianCrowd = ca && ca.crowding >= 40 && ((ca.side === 'LONG_CROWDED' && cand.direction === 'SHORT') || (ca.side === 'SHORT_CROWDED' && cand.direction === 'LONG')) ? 1 : 0;
      votes.fearGreed = fng != null ? (fng <= 25 ? 1 * dir : fng >= 75 ? -1 * dir : 0) : 0;
      const rs = rsOf[cand.asset]?.rsVsBtc;
      votes.relStrength = rs != null ? (rs > 10 ? 0.5 * dir : rs < -10 ? -0.5 * dir : 0) : 0;
      const conviction = +Object.values(votes).reduce((a, b) => a + b, 0).toFixed(1);

      if (conviction < CONVICTION_MIN) {
        record({ asset: cand.asset, direction: cand.direction, source: cand.source, action: 'REJECTED', conviction, votes, rationale: `conviction ${conviction} < ${CONVICTION_MIN}` });
        continue;
      }

      // ── VIZIER REVIEW ──
      let vizier = { verdict: 'CONCUR', sizeMultiplier: 1, reason: 'Vizier unreachable — mechanical rules govern (constitutional fail-safe)' };
      try {
        const res = await fetch(SIBLINGS.VIZIER + '/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asset: cand.asset, direction: cand.direction, source: cand.source, setup: cand.rationale,
            conviction, tier2: votes, tier1: 'ALL PASSED', plannedRiskPct: RISK_PCT,
            entry: 'market ' + px, stop: `${ATR_STOP_MULT}×ATR`, target: `${TARGET_R}R`,
            engineReport: `score ${cand.engineScore ?? '—'} · ATR ${cand.atrPct ?? '—'}%`,
            depthReport: db ? `${db.band} score ${db.liqScore}` : 'not tracked (vol/OI sanity passed)',
            crowdReport: ca ? `${ca.side} ${ca.crowding} funding ${ca.fundingApr}%` : '—',
            matrixReport: rs != null ? `RS ${rs}% vs BTC` : '—', volRegime, fng }),
          timeout: 90000,
        });
        if (res.ok) vizier = await res.json();
      } catch (e) {}
      if (!['CONCUR', 'CONCUR_REDUCED', 'OBJECT'].includes(vizier.verdict)) vizier = { verdict: 'CONCUR', sizeMultiplier: 1, reason: 'malformed review — mechanical rules govern' };
      // Thesis cluster: force half-size on the 2nd concurrent position sharing the same contrarian
      // macro bet, even when Vizier itself said plain CONCUR — this is what the asset-correlation
      // cluster cap misses, since these tickers aren't price-correlated to each other.
      if (thesisTag && sameThesisOpen === 1 && vizier.verdict === 'CONCUR') {
        vizier = { verdict: 'CONCUR_REDUCED', sizeMultiplier: Math.min(vizier.sizeMultiplier || 1, 0.5),
          reason: `THESIS_CLUSTER: 2nd concurrent ${thesisTag} — size halved regardless of individual conviction. ${vizier.reason || ''}`.slice(0, 300) };
      }
      // Broadcast full Vizier reasoning (not just the verdict) to the network bus so KAIZEN can
      // actually see WHY trades were approved/reduced/objected, not only that they were.
      toHub('VIZIER', 'vizier.memo', { asset: cand.asset, direction: cand.direction, verdict: vizier.verdict,
        reason: (vizier.reason || '').slice(0, 300), conviction, thesisTag: thesisTag || null, sameThesisOpen, fng });
      if (vizier.verdict === 'OBJECT') {
        state.vetoCounts.VIZIER_OBJECT = (state.vetoCounts.VIZIER_OBJECT || 0) + 1;
        record({ asset: cand.asset, direction: cand.direction, source: cand.source, action: 'VIZIER_OBJECTED', conviction, votes, vizier: { verdict: vizier.verdict, reason: vizier.reason } });
        continue;
      }

      // ── SIZE & EXECUTE (paper) ──
      const atrPct = cand.atrPct || 3;
      const riskDistPct = (ATR_STOP_MULT * atrPct) / 100;
      const convMult = Math.max(0.5, Math.min(1.5, conviction / CONVICTION_MIN));
      const riskUsd = eq * (RISK_PCT / 100) * convMult * (vizier.sizeMultiplier || 1);
      let notional = riskUsd / riskDistPct;
      notional = Math.min(notional, eq * MAX_LEV / 2);           // leverage guard
      if (notional < 10) {
        record({ asset: cand.asset, direction: cand.direction, source: cand.source, action: 'REJECTED', conviction, rationale: 'position below $10 minimum after sizing' });
        continue;
      }
      const slip = (SLIP_BPS / 10000) * dir;
      const fillPx = px * (1 + slip);
      const entryFee = notional * FEE_BPS / 10000;
      state.posSeq++;
      const pos = {
        id: state.posSeq, asset: cand.asset, direction: cand.direction, source: cand.source, blueprint: cand.blueprint || null,
        thesisTag: thesisTag || null,
        entryPx: +fillPx.toPrecision(6), notional: +notional.toFixed(2),
        riskUsd: +riskUsd.toFixed(2), riskDist: fillPx * riskDistPct,
        stopPx: +(fillPx * (1 - dir * riskDistPct)).toPrecision(6),
        targetPx: +(fillPx * (1 + dir * riskDistPct * TARGET_R)).toPrecision(6),
        trailArmed: false, openedAt: nowIso(), conviction, votes, vizier: { verdict: vizier.verdict, reason: (vizier.reason || '').slice(0, 160) },
      };
      state.realized -= entryFee; state.fees += entryFee;
      state.positions.push(pos);
      state.todayOpens++; executed++;
      record({ asset: pos.asset, direction: pos.direction, source: pos.source, action: 'EXECUTED', conviction, votes,
        vizier: pos.vizier, sizing: { notional: pos.notional, riskUsd: pos.riskUsd, entry: pos.entryPx, stop: pos.stopPx, target: pos.targetPx } });
      emit('TRADE', 'supreme.position.open', pos, 'HIGH');
      if (EMAIL_TRADES) sendEmail(`👑 OPENED: ${pos.direction} ${pos.asset} @ ${pos.entryPx}`,
        tradeOpenHtml(pos)).catch(()=>{});
    }
    emit('SYS', 'supreme.cycle.complete', { cycle: state.cycleCount, candidates: candidates.length, executed, positions: state.positions.length, equity: +equityNow().toFixed(2) });
  } catch (err) { reportError('cycle: ' + err.message); }
}

// ─── POSITION MANAGEMENT (deterministic) ──────────────────────────────────────
async function manage() {
  if (!state.positions.length) { updateEquityStats(); return; }
  await refreshPrices();
  const toClose = [];
  for (const pos of state.positions) {
    const px = state.prices[pos.asset];
    if (!px) continue;
    const d = pos.direction === 'LONG' ? 1 : -1;
    const r = rNow(pos, px);
    // Breakeven + trail once +1R
    if (!pos.trailArmed && r >= 1) { pos.trailArmed = true; pos.stopPx = pos.entryPx; emit('SYS', 'supreme.trail', { id: pos.id, asset: pos.asset, note: 'stop → breakeven at +1R' }); }
    if (pos.trailArmed) {
      const trail = px * (1 - d * (pos.riskDist / pos.entryPx));
      if (d === 1 && trail > pos.stopPx) pos.stopPx = +trail.toPrecision(6);
      if (d === -1 && trail < pos.stopPx) pos.stopPx = +trail.toPrecision(6);
    }
    const hitStop = d === 1 ? px <= pos.stopPx : px >= pos.stopPx;
    const hitTarget = d === 1 ? px >= pos.targetPx : px <= pos.targetPx;
    const ageH = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
    const venue = (state.snapshot['SENTINEL-01']?.stats?.venue || '').toUpperCase();
    if (hitStop) toClose.push({ pos, px: pos.stopPx, reason: pos.trailArmed ? 'TRAIL_STOP' : 'STOP' });
    else if (hitTarget) toClose.push({ pos, px: pos.targetPx, reason: 'TARGET' });
    else if (ageH >= MAX_HOLD_H) toClose.push({ pos, px, reason: 'TIME_STOP' });
    else if (venue === 'DEGRADED') toClose.push({ pos, px, reason: 'VENUE_DEGRADED(Tier-1 fact change)' });
  }
  toClose.forEach(({ pos, px, reason }) => closePosition(pos, px, reason));
  updateEquityStats();
}
function closePosition(pos, px, reason) {
  const d = pos.direction === 'LONG' ? 1 : -1;
  const slip = (SLIP_BPS / 10000) * -d;
  const fillPx = px * (1 + slip);
  const pnl = d * (fillPx - pos.entryPx) / pos.entryPx * pos.notional;
  const exitFee = pos.notional * FEE_BPS / 10000;
  const netPnl = pnl - exitFee;
  const rMult = +(d * (fillPx - pos.entryPx) / pos.riskDist).toFixed(2);
  state.realized += netPnl; state.fees += exitFee;
  state.positions = state.positions.filter(p => p.id !== pos.id);
  const trade = { ...pos, exitPx: +fillPx.toPrecision(6), closedAt: nowIso(), reason, pnl: +netPnl.toFixed(2), r: rMult };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 500);
  record({ asset: pos.asset, direction: pos.direction, source: pos.source, action: 'CLOSED', rationale: `${reason} · ${rMult}R · ${fmt$(netPnl)}` });
  emit('TRADE', 'supreme.position.close', trade, 'HIGH');
  if (EMAIL_TRADES) sendEmail(`👑 CLOSED: ${trade.direction} ${trade.asset} → ${fmt$(trade.pnl)} (${trade.r}R · ${reason})`, tradeCloseHtml(trade)).catch(()=>{});
  saveState();
}
function updateEquityStats() {
  const eq = equityNow();
  state.equity = +eq.toFixed(2);
  if (eq > state.peakEquity) state.peakEquity = eq;
  const dd = state.peakEquity > 0 ? ((state.peakEquity - eq) / state.peakEquity) * 100 : 0;
  if (dd > state.maxDrawdownPct) state.maxDrawdownPct = +dd.toFixed(2);
}

// ─── Graduation scoreboard ────────────────────────────────────────────────────
function scoreboard() {
  const closed = state.trades;
  const wins = closed.filter(t => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99 : 0);
  const days = +((Date.now() - state.bornAt) / 86400000).toFixed(1);
  const vetoesFired = Object.values(state.vetoCounts).reduce((a, b) => a + b, 0);
  return {
    trades: closed.length, winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : 0,
    profitFactor: pf, avgR: closed.length ? +(closed.reduce((s, t) => s + t.r, 0) / closed.length).toFixed(2) : 0,
    maxDrawdownPct: state.maxDrawdownPct, days, vetoesFired,
    criteria: { trades30: closed.length >= 30, pf12: pf > 1.2, dd15: state.maxDrawdownPct < 15, days21: days >= 21, vetoesProven: vetoesFired >= 5 },
  };
}

// ─── HERALD templates ─────────────────────────────────────────────────────────
const H = (t) => `<div style="font-family:monospace;background:#0d0a04;color:#f0e6d0;padding:24px;border-radius:8px">${t}</div>`;
const row = (k, v) => `<tr><td style="color:#9a8a60;padding:3px 12px 3px 0">${k}</td><td style="color:#fff4de;font-weight:bold">${v}</td></tr>`;
function tradeOpenHtml(p) {
  return H(`<h2 style="color:#f5c518">👑 Position Opened — PAPER</h2><table>${
    row('Asset', `${p.direction} ${p.asset}`)}${row('Entry', p.entryPx)}${row('Size', fmt$(p.notional))}${
    row('Risk', fmt$(p.riskUsd))}${row('Stop / Target', `${p.stopPx} / ${p.targetPx}`)}${
    row('Conviction', p.conviction)}${row('Vizier', `${p.vizier.verdict} — ${p.vizier.reason}`)}${
    row('Source', p.source + (p.blueprint ? ' · ' + p.blueprint : ''))}</table>`);
}
function tradeCloseHtml(t) {
  const c = t.pnl >= 0 ? '#27c97a' : '#e05050';
  return H(`<h2 style="color:${c}">👑 Position Closed — ${fmt$(t.pnl)} (${t.r}R)</h2><table>${
    row('Asset', `${t.direction} ${t.asset}`)}${row('Entry → Exit', `${t.entryPx} → ${t.exitPx}`)}${
    row('Reason', t.reason)}${row('Held', ((new Date(t.closedAt) - new Date(t.openedAt)) / 3600000).toFixed(1) + 'h')}${
    row('Equity now', fmt$(equityNow()))}</table>`);
}
function digestHtml() {
  const sb = scoreboard();
  const posRows = state.positions.map(p => {
    const px = state.prices[p.asset] || p.entryPx;
    return `<tr>${['', p.direction + ' ' + p.asset, p.entryPx, px.toPrecision(6), rNow(p, px).toFixed(2) + 'R', fmt$(unrealized(p, px))].map(v => `<td style="padding:3px 10px;color:#fff4de">${v}</td>`).join('')}</tr>`;
  }).join('') || '<tr><td style="color:#9a8a60;padding:6px">no open positions</td></tr>';
  const tRows = state.trades.slice(0, 8).map(t =>
    `<tr>${[t.direction + ' ' + t.asset, t.r + 'R', fmt$(t.pnl), t.reason].map(v => `<td style="padding:3px 10px;color:${t.pnl >= 0 ? '#27c97a' : '#e05050'}">${v}</td>`).join('')}</tr>`).join('') || '<tr><td style="color:#9a8a60;padding:6px">no closed trades yet</td></tr>';
  const crit = sb.criteria;
  const check = b => b ? '✅' : '⬜';
  return H(`<h2 style="color:#f5c518">👑 Daily Digest — State of the Treasury (PAPER)</h2>
  <table>${row('Equity', `<span style="font-size:18px">${fmt$(state.equity)}</span> (start ${fmt$(START_BUDGET)})`)}${
    row('Realized / Fees', `${fmt$(state.realized)} / ${fmt$(state.fees)}`)}${
    row('Max drawdown', sb.maxDrawdownPct + '%')}${row('Decision cycles', state.cycleCount)}</table>
  <h3 style="color:#d4a017">Open Positions</h3><table>${posRows}</table>
  <h3 style="color:#d4a017">Recent Trades</h3><table>${tRows}</table>
  <h3 style="color:#d4a017">🎓 Graduation Scoreboard</h3>
  <table>${row('Trades', `${sb.trades}/30 ${check(crit.trades30)}`)}${row('Profit factor', `${sb.profitFactor} (>1.2) ${check(crit.pf12)}`)}${
    row('Win rate / Avg R', `${sb.winRate}% / ${sb.avgR}R`)}${row('Drawdown', `${sb.maxDrawdownPct}% (<15%) ${check(crit.dd15)}`)}${
    row('Days', `${sb.days}/21 ${check(crit.days21)}`)}${row('Vetoes proven', `${sb.vetoesFired} fired ${check(crit.vetoesProven)}`)}</table>
  <p style="color:#9a8a60;font-size:11px">Real money flows only when every box is checked. — SUPREME LEADER</p>`);
}
setInterval(() => {
  const now = new Date();
  const key = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === DIGEST_HOUR_UTC && state.lastDigestKey !== key) {
    state.lastDigestKey = key;
    sendEmail(`👑 Daily Digest — Equity ${fmt$(equityNow())} · ${state.trades.length} trades`, digestHtml()).catch(()=>{});
  }
}, 60000);

// ─── App / Bus / GECKO ────────────────────────────────────────────────────────
const app = express(); app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function broadcast(e){const p=JSON.stringify({...e,agentId:'SUPREME-LEADER',timestamp:nowIso()});wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(p);});}
function emit(type,topic,data,severity='INFO'){broadcast({type,topic,data,severity});console.log(`[${nowIso()}] [${type}] [${topic}] ${JSON.stringify(data).substring(0,140)}`);}
let geckoWs=null;
function connectGecko(){geckoWs=new WebSocket(GECKO_URL);
  geckoWs.on('open',()=>{state.geckoConnected=true;emit('SYS','supreme.gecko.connected',{});});
  geckoWs.on('close',()=>{state.geckoConnected=false;setTimeout(connectGecko,5000);});
  geckoWs.on('error',()=>{});
  geckoWs.on('message',raw=>{try{ingest(JSON.parse(raw.toString()));}catch(e){}});}
connectGecko();
setInterval(()=>{if(geckoWs?.readyState===WebSocket.OPEN){geckoWs.send(JSON.stringify({type:'PING'}));
  geckoWs.send(JSON.stringify({type:'STATUS',agentId:'SUPREME-LEADER',stats:{equity:'$'+state.equity.toFixed(0),positions:state.positions.length,trades:state.trades.length}}));}},15000);
// Publish a message onto the GECKO-01 hub (the real inter-agent bus) — distinct from emit(), which
// only reaches SUPREME-LEADER's own local dashboard clients. Needed so KAIZEN etc. actually hear this.
function toHub(type, topic, data) {
  if (geckoWs && geckoWs.readyState === WebSocket.OPEN) {
    try { geckoWs.send(JSON.stringify({ type, topic, agentId: 'SUPREME-LEADER', data, timestamp: nowIso() })); } catch (e) {}
  }
}

wss.on('connection',ws=>{
  ws.send(JSON.stringify({type:'SYS',topic:'supreme.handshake',agentId:'SUPREME-LEADER',timestamp:nowIso(),
    data:{geckoConnected:state.geckoConnected,mode:state.mode,paused:state.paused,
      equity:state.equity,startBudget:START_BUDGET,realized:state.realized,fees:state.fees,
      positions:state.positions.map(p=>({...p,mark:state.prices[p.asset],unreal:state.prices[p.asset]?+unrealized(p,state.prices[p.asset]).toFixed(2):0,rNow:state.prices[p.asset]?+rNow(p,state.prices[p.asset]).toFixed(2):0})),
      trades:state.trades.slice(0,30),decisions:state.decisions.slice(0,40),
      scoreboard:scoreboard(),vetoCounts:state.vetoCounts,siblingStatus:state.siblingStatus,
      herald:{configured:!!(EMAIL_TO&&GMAIL_APP_PASSWORD),to:EMAIL_TO?EMAIL_TO.replace(/(.{2}).*(@.*)/,'$1***$2'):null,sent:state.emailsSent},
      snapshot:{MACRO:state.snapshot['MACRO-01']?.stats,SHERLOCK:state.snapshot['SHERLOCK-01']?.stats,SENTINEL:state.snapshot['SENTINEL-01']?.stats,CROWD:state.snapshot['CROWD-01']?.stats},
      stats:{uptime:Date.now()-state.startTime,cycles:state.cycleCount,lastCycle:state.lastCycleAt}}}));
  ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());
    if(m.type==='PING')ws.send(JSON.stringify({type:'PONG',agentId:'SUPREME-LEADER'}));
    if(m.type==='CYCLE')decisionCycle();
    if(m.type==='PAUSE'){state.paused=true;emit('SYS','supreme.paused',{});}
    if(m.type==='RESUME'){state.paused=false;emit('SYS','supreme.resumed',{});}
    if(m.type==='TEST_EMAIL')sendEmail('👑 HERALD test — the throne can reach you',digestHtml()).then(ok=>emit('SYS','supreme.email.test',{ok}));
    if(m.type==='CLOSE_POSITION'&&m.id){const p=state.positions.find(x=>x.id===m.id);if(p&&state.prices[p.asset])closePosition(p,state.prices[p.asset],'MANUAL');}
  }catch(e){}});});

app.get('/health',(_,res)=>res.json({agent:'SUPREME-LEADER',status:'LIVE',mode:state.mode,paused:state.paused,
  geckoConnected:state.geckoConnected,uptime:Date.now()-state.startTime,cycles:state.cycleCount,
  equity:state.equity,positions:state.positions.length,trades:state.trades.length,
  herald:!!(EMAIL_TO&&GMAIL_APP_PASSWORD),siblings:state.siblingStatus,errors:state.errors.slice(-3)}));
app.get('/treasury',(_,res)=>res.json({equity:state.equity,startBudget:START_BUDGET,realized:state.realized,fees:state.fees,
  positions:state.positions,scoreboard:scoreboard()}));
app.get('/decisions',(_,res)=>res.json({decisions:state.decisions}));
app.get('/trades',(_,res)=>res.json({trades:state.trades}));
app.post('/cycle',(_,res)=>{decisionCycle();res.json({ok:true});});
app.post('/pause',(_,res)=>{state.paused=true;res.json({paused:true});});
app.post('/resume',(_,res)=>{state.paused=false;res.json({paused:false});});
app.post('/digest',(_,res)=>{sendEmail(`👑 Daily Digest — Equity ${fmt$(equityNow())}`,digestHtml()).then(ok=>res.json({sent:ok}));});
const { mountWeeklyReport } = require('./weekly-report');
mountWeeklyReport(app, {
  getState: () => state,
  getConfig: () => ({ START_BUDGET, RISK_PCT, CONVICTION_MIN, MAX_POSITIONS,
    MAX_NEW_PER_DAY, MAX_LEV, NET_DELTA_CAP, ATR_STOP_MULT, TARGET_R, MAX_HOLD_H,
    FEE_BPS, SLIP_BPS, MIN_VOL_USD, MIN_OI_USD, ENTRY_SCORE, DECISION_MS, STRATEGY_MODE }),
  getScoreboard: () => scoreboard(),
  getEquityNow:  () => equityNow(),
});
server.listen(PORT,()=>{
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   👑 SUPREME LEADER — The Throne               ║');
  console.log('║   Paper mode · two-tier constitution · Herald  ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  console.log(`  HTTP    →  http://localhost:${PORT}`);
  console.log(`  Budget  →  $${START_BUDGET} paper · ${RISK_PCT}% risk · max ${MAX_POSITIONS} positions · ${MAX_LEV}x lev cap`);
  console.log(`  Cycle   →  decisions every ${DECISION_MS/60000}min · management every ${MANAGE_MS/1000}s`);
  console.log(`  Herald  →  ${EMAIL_TO&&GMAIL_APP_PASSWORD?'configured → '+EMAIL_TO:'⚠ email not configured (set EMAIL_TO, EMAIL_FROM, GMAIL_APP_PASSWORD)'}`);
  console.log(`  State   →  ${STATE_DIR} ${fs.existsSync('/data')?'(volume — survives redeploys)':'(⚠ ephemeral — add a Railway volume at /data)'}\n`);
  refreshPrices();
  setTimeout(decisionCycle, 90000);
  setInterval(decisionCycle, DECISION_MS);
  setInterval(manage, MANAGE_MS);
});
process.on('SIGTERM',()=>{saveState();process.exit(0);});
process.on('SIGINT',()=>{saveState();process.exit(0);});
