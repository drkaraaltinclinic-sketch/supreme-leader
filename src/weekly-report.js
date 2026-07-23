'use strict';

/**
 * weekly-report.js — SUPREME-LEADER weekly report generator
 * v1.1 · mapped to the real agent.js schema (state.trades / state.decisions / state.meta)
 *
 * Mounts:
 *   GET /api/report/weekly       → markdown as text/plain (paste straight into chat)
 *   GET /api/report/weekly.json  → same data, structured
 *
 * Add to src/agent.js just above `server.listen(PORT, ...)`:
 *
 *   const { mountWeeklyReport } = require('./weekly-report');
 *   mountWeeklyReport(app, {
 *     getState: () => state,
 *     getConfig: () => ({ START_BUDGET, RISK_PCT, CONVICTION_MIN, MAX_POSITIONS,
 *       MAX_NEW_PER_DAY, MAX_LEV, NET_DELTA_CAP, ATR_STOP_MULT, TARGET_R, MAX_HOLD_H,
 *       FEE_BPS, SLIP_BPS, MIN_VOL_USD, MIN_OI_USD, ENTRY_SCORE, DECISION_MS, STRATEGY_MODE }),
 *     getScoreboard: () => scoreboard(),
 *     getEquityNow:  () => equityNow(),
 *   });
 */

const MAX_TRADE_ROWS = 60;
const WINDOW_DAYS = 7;
const DECISION_CAP = 200;   // state.decisions.slice(0, 200) in agent.js

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const money = (v) => (Number.isFinite(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}` : '—');
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');
const rfmt = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—');
const hrs = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}h` : '—');
const usdM = (v) => (Number.isFinite(v) ? `$${(v / 1e6).toFixed(2)}M` : '—');
const safe = (fn, fb) => { try { const r = fn(); return r === undefined ? fb : r; } catch { return fb; } };

function heldHours(t) {
  const a = new Date(t.openedAt), b = new Date(t.closedAt);
  if (isNaN(a) || isNaN(b)) return NaN;
  return (b - a) / 3600000;
}

// ── stats ────────────────────────────────────────────────────────────────────
function computeProfitFactor(trades) {
  let gp = 0, gl = 0;
  for (const t of trades) {
    const p = num(t.pnl, NaN);
    if (!Number.isFinite(p)) continue;
    if (p > 0) gp += p; else gl += Math.abs(p);
  }
  return { grossProfit: gp, grossLoss: gl, profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0) };
}

/** Scratches (pnl exactly 0) are excluded from the denominator, not counted either way. */
function computeWinRate(trades) {
  const scored = trades.filter((t) => Number.isFinite(num(t.pnl, NaN)));
  const wins = scored.filter((t) => t.pnl > 0).length;
  const losses = scored.filter((t) => t.pnl < 0).length;
  const scratches = scored.filter((t) => t.pnl === 0).length;
  const decisive = wins + losses;
  return { wins, losses, scratches, n: scored.length, winRate: decisive ? (wins / decisive) * 100 : NaN };
}

function aggregateByExitReason(trades) {
  const m = new Map();
  for (const t of trades) {
    const key = t.reason || 'UNKNOWN';
    if (!m.has(key)) m.set(key, { reason: key, count: 0, rSum: 0, rN: 0, pnl: 0, holdSum: 0, holdN: 0 });
    const row = m.get(key);
    row.count++;
    const r = num(t.r, NaN);
    if (Number.isFinite(r)) { row.rSum += r; row.rN++; }
    const p = num(t.pnl, NaN);
    if (Number.isFinite(p)) row.pnl += p;
    const h = heldHours(t);
    if (Number.isFinite(h)) { row.holdSum += h; row.holdN++; }
  }
  return [...m.values()]
    .map((r) => ({ ...r, avgR: r.rN ? r.rSum / r.rN : NaN, avgHold: r.holdN ? r.holdSum / r.holdN : NaN }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Court-record analysis.
 *
 * agent.js caps state.decisions at 200 and each entry carries a unique decSeq `id`,
 * so the stored record CANNOT exceed 200 rows and cannot contain duplicates.
 * If the dashboard displays a larger number, the inflation is in the browser —
 * the handshake ships decisions.slice(0, 40) and the client is appending rather
 * than replacing on each reconnect. This section reports both so the distinction
 * is visible rather than inferred.
 */
function analyseDecisions(decisions, vetoCounts) {
  const ids = new Set();
  const actions = new Map();
  const vetoInRecord = new Map();

  for (const d of decisions) {
    ids.add(d.id ?? `${d.at}|${d.asset}|${d.action}`);
    const a = d.action || 'UNKNOWN';
    actions.set(a, (actions.get(a) || 0) + 1);
    for (const v of arr(d.vetoes)) {
      const key = String(v).split('(')[0];
      vetoInRecord.set(key, (vetoInRecord.get(key) || 0) + 1);
    }
  }

  const executed = actions.get('EXECUTED') || 0;
  const evaluated = [...actions.entries()]
    .filter(([k]) => k !== 'CLOSED')
    .reduce((s, [, v]) => s + v, 0);

  return {
    storedRows: decisions.length,
    distinctIds: ids.size,
    storageCap: DECISION_CAP,
    atCap: decisions.length >= DECISION_CAP,
    duplicatesInStorage: decisions.length - ids.size,
    actionBreakdown: [...actions.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
    vetoesInRecord: [...vetoInRecord.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    vetoCountsAllTime: Object.entries(obj(vetoCounts)).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    executed,
    evaluated,
    executionRate: evaluated ? (executed / evaluated) * 100 : NaN,
  };
}

/**
 * Liquidity gate diagnostic — the thing screenshots could never show.
 *
 * EXECUTION_SANITY(thin market) fires on `volUsd < MIN_VOL_USD || oiUsd < MIN_OI_USD`.
 * This lists what those numbers ACTUALLY are per asset, so a genuinely thin market
 * is distinguishable from a threshold set too high for this venue's depth.
 */
function liquidityGate(meta, cfg) {
  const minVol = num(cfg.MIN_VOL_USD, 10e6);
  const minOi = num(cfg.MIN_OI_USD, 5e6);
  const rows = Object.entries(obj(meta)).map(([asset, m]) => {
    const volUsd = num(m.volUsd, 0), oiUsd = num(m.oiUsd, 0);
    const failVol = volUsd < minVol, failOi = oiUsd < minOi;
    return { asset, volUsd, oiUsd, failVol, failOi, passes: !failVol && !failOi,
      volRatio: minVol ? volUsd / minVol : NaN, oiRatio: minOi ? oiUsd / minOi : NaN };
  });
  const passing = rows.filter((r) => r.passes);
  return {
    minVolUsd: minVol, minOiUsd: minOi,
    universeSize: rows.length,
    passing: passing.length,
    passRate: rows.length ? (passing.length / rows.length) * 100 : NaN,
    failingOnOiOnly: rows.filter((r) => r.failOi && !r.failVol).length,
    failingOnVolOnly: rows.filter((r) => r.failVol && !r.failOi).length,
    passingList: passing.map((r) => r.asset).sort(),
    nearMisses: rows.filter((r) => !r.passes && (r.volRatio > 0.5 || r.oiRatio > 0.5))
      .sort((a, b) => (b.volRatio + b.oiRatio) - (a.volRatio + a.oiRatio)).slice(0, 15),
  };
}

// ── assembly ─────────────────────────────────────────────────────────────────
function buildReport({ state, config, scoreboard, equityNow } = {}) {
  const s = obj(state);
  const cfg = obj(config);
  const sb = obj(scoreboard);

  const trades = arr(s.trades);
  const positions = arr(s.positions);
  const decisions = arr(s.decisions);

  const startBudget = num(cfg.START_BUDGET, 100);
  const eqNow = num(equityNow, num(s.equity, startBudget));
  const realized = num(s.realized, 0);
  const unrealized = eqNow - startBudget - realized;
  const days = s.bornAt ? (Date.now() - s.bornAt) / 86400000 : NaN;

  const windowTrades = trades.filter((t) => {
    const d = new Date(t.closedAt);
    return !isNaN(d) && Date.now() - d.getTime() <= WINDOW_DAYS * 86400000;
  });

  const maxPos = num(cfg.MAX_POSITIONS, 4);
  const totalRisk = positions.reduce((a, p) => a + num(p.riskUsd, 0), 0);
  const netDelta = positions.reduce((a, p) => a + (p.direction === 'LONG' ? 1 : -1) * num(p.notional, 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    version: '1.1',
    windowDays: WINDOW_DAYS,

    performance: {
      equity: eqNow, startBudget, realized, unrealized,
      fees: num(s.fees, 0),
      totalReturnPct: startBudget ? ((eqNow - startBudget) / startBudget) * 100 : NaN,
      days, cycleCount: num(s.cycleCount, 0), lastCycleAt: s.lastCycleAt || null,
      paused: !!s.paused, geckoConnected: !!s.geckoConnected,
      maxDrawdownPct: num(s.maxDrawdownPct, NaN),
    },

    allTime: { ...computeProfitFactor(trades), ...computeWinRate(trades), trades: trades.length },
    thisWeek: { ...computeProfitFactor(windowTrades), ...computeWinRate(windowTrades), trades: windowTrades.length },
    scoreboard: sb,

    // Is the book full? If positions >= MAX_POSITIONS the decision loop breaks on the
    // FIRST candidate — zero executions is then correct behaviour, not a gate failure.
    capacity: {
      open: positions.length, max: maxPos, full: positions.length >= maxPos,
      todayOpens: num(s.todayOpens, 0), maxNewPerDay: num(cfg.MAX_NEW_PER_DAY, 3),
      totalRiskUsd: totalRisk, riskPctOfEquity: eqNow ? (totalRisk / eqNow) * 100 : NaN,
      netDeltaUsd: netDelta, netDeltaXEquity: eqNow ? netDelta / eqNow : NaN,
      netDeltaCap: num(cfg.NET_DELTA_CAP, 1.5),
    },

    exitReasons: aggregateByExitReason(trades),
    decisionAnalysis: analyseDecisions(decisions, s.vetoCounts),
    liquidity: liquidityGate(s.meta, cfg),
    siblingStatus: obj(s.siblingStatus),
    errors: arr(s.errors).slice(-8),
    config: cfg,

    positions: positions.map((p) => ({
      asset: p.asset, direction: p.direction, entryPx: p.entryPx,
      mark: obj(s.prices)[p.asset] ?? null, notional: p.notional, riskUsd: p.riskUsd,
      stopPx: p.stopPx, targetPx: p.targetPx, trailArmed: !!p.trailArmed,
      thesisTag: p.thesisTag || null, conviction: p.conviction,
      vizier: obj(p.vizier).verdict || null, source: p.source, openedAt: p.openedAt,
    })),

    trades: trades.slice(0, MAX_TRADE_ROWS).map((t) => ({
      asset: t.asset, direction: t.direction, entryPx: t.entryPx, exitPx: t.exitPx,
      r: num(t.r, NaN), pnl: num(t.pnl, NaN), reason: t.reason,
      heldHours: heldHours(t), vizier: obj(t.vizier).verdict || '',
      thesisTag: t.thesisTag || '', conviction: t.conviction, source: t.source, closedAt: t.closedAt,
    })),
    tradesTruncated: Math.max(0, trades.length - MAX_TRADE_ROWS),
  };
}

// ── markdown ─────────────────────────────────────────────────────────────────
function renderMarkdown(rep) {
  const L = [];
  const p = rep.performance;
  const pf = (v) => (v === Infinity ? '∞' : Number.isFinite(v) ? v.toFixed(2) : '—');

  L.push(`# SUPREME-LEADER — Weekly Report`);
  L.push(`${rep.generatedAt} · v${rep.version}`);
  L.push('');

  L.push(`## 1. Headline`);
  L.push('');
  L.push(`| Metric | Value |`, `|---|---|`);
  L.push(`| Equity | ${money(p.equity)} (start ${money(p.startBudget)}, ${pct(p.totalReturnPct)}) |`);
  L.push(`| Realized / Unrealized | ${money(p.realized)} / ${money(p.unrealized)} |`);
  L.push(`| Fees | ${money(p.fees)} |`);
  L.push(`| Closed trades | ${rep.allTime.trades} |`);
  L.push(`| Win rate | ${pct(rep.allTime.winRate, 1)} (${rep.allTime.wins}W/${rep.allTime.losses}L${rep.allTime.scratches ? `/${rep.allTime.scratches} scratch` : ''}) |`);
  L.push(`| Profit factor | ${pf(rep.allTime.profitFactor)} |`);
  L.push(`| Max drawdown | ${pct(p.maxDrawdownPct)} |`);
  L.push(`| Day / cycle | ${Number.isFinite(p.days) ? p.days.toFixed(1) : '—'} / #${p.cycleCount} |`);
  L.push(`| Status | ${p.paused ? 'PAUSED' : 'running'} · gecko ${p.geckoConnected ? 'connected' : 'DISCONNECTED'} |`);
  L.push('');
  L.push(`Last ${rep.windowDays}d: ${rep.thisWeek.trades} trades · win rate ${pct(rep.thisWeek.winRate, 1)} · PF ${pf(rep.thisWeek.profitFactor)}`);
  L.push('');

  L.push(`## 2. Capacity — is the book full?`);
  L.push('');
  const c = rep.capacity;
  L.push(`Open positions: **${c.open}/${c.max}**${c.full ? ' — **FULL**' : ''} · opened today ${c.todayOpens}/${c.maxNewPerDay}`);
  L.push('');
  if (c.full) {
    L.push(`> Book is at MAX_POSITIONS. The decision loop breaks on the first candidate, so`);
    L.push(`> "N candidates · 0 executed" is expected behaviour this cycle, not a gate failure.`);
    L.push('');
  }
  L.push(`Risk ${money(c.totalRiskUsd)} (${pct(c.riskPctOfEquity)} of equity) · net delta ${money(c.netDeltaUsd)} = ${Number.isFinite(c.netDeltaXEquity) ? c.netDeltaXEquity.toFixed(2) : '—'}x equity (cap ${c.netDeltaCap}x)`);
  L.push('');

  L.push(`## 3. Graduation scoreboard`);
  L.push('');
  const sb = rep.scoreboard, cr = obj(sb.criteria);
  const yn = (b) => (b ? 'PASS' : 'no');
  L.push(`| Gate | Value | Required | |`, `|---|---|---|---|`);
  L.push(`| Trades | ${sb.trades ?? '—'} | ≥ 30 | ${yn(cr.trades30)} |`);
  L.push(`| Profit factor | ${sb.profitFactor ?? '—'} | > 1.2 | ${yn(cr.pf12)} |`);
  L.push(`| Drawdown | ${sb.maxDrawdownPct ?? '—'}% | < 15% | ${yn(cr.dd15)} |`);
  L.push(`| Days | ${sb.days ?? '—'} | ≥ 21 | ${yn(cr.days21)} |`);
  L.push(`| Vetoes proven | ${sb.vetoesFired ?? '—'} | ≥ 5 | ${yn(cr.vetoesProven)} |`);
  L.push('');

  L.push(`## 4. Exit-reason breakdown`);
  L.push('');
  if (!rep.exitReasons.length) L.push(`No closed trades.`);
  else {
    L.push(`| Exit reason | Count | Avg R | Avg hold | Net P&L |`, `|---|---|---|---|---|`);
    for (const r of rep.exitReasons) L.push(`| ${r.reason} | ${r.count} | ${rfmt(r.avgR)} | ${hrs(r.avgHold)} | ${money(r.pnl)} |`);
  }
  L.push('');

  L.push(`## 5. Decision record`);
  L.push('');
  const d = rep.decisionAnalysis;
  L.push(`Stored rows: **${d.storedRows}** (cap ${d.storageCap}) · distinct ids: **${d.distinctIds}** · duplicates in storage: **${d.duplicatesInStorage}**`);
  L.push('');
  if (d.duplicatesInStorage > 0) {
    L.push(`> Duplicates present in stored data — server-side writer is re-appending.`);
  } else {
    L.push(`> Stored record is clean and capped at ${d.storageCap}. Any larger number shown on the`);
    L.push(`> dashboard is a client-side render fault (public/), not a server write bug.`);
  }
  L.push('');
  L.push(`Evaluated ${d.evaluated} · executed ${d.executed} · rate ${pct(d.executionRate, 1)}`);
  L.push('');
  if (d.actionBreakdown.length) {
    L.push(`| Action | Count (in record) |`, `|---|---|`);
    for (const a of d.actionBreakdown) L.push(`| ${a.action} | ${a.count} |`);
    L.push('');
  }
  if (d.vetoCountsAllTime.length) {
    L.push(`Veto tally (all time, from state.vetoCounts):`);
    L.push('');
    L.push(`| Veto | Count |`, `|---|---|`);
    for (const v of d.vetoCountsAllTime) L.push(`| ${v.reason} | ${v.count} |`);
    L.push('');
  }

  L.push(`## 6. Liquidity gate`);
  L.push('');
  const lq = rep.liquidity;
  L.push(`Thresholds: vol ≥ ${usdM(lq.minVolUsd)} · OI ≥ ${usdM(lq.minOiUsd)}`);
  L.push('');
  L.push(`**${lq.passing} of ${lq.universeSize}** assets pass (${pct(lq.passRate, 1)}). Failing on OI only: ${lq.failingOnOiOnly} · on volume only: ${lq.failingOnVolOnly}`);
  L.push('');
  if (lq.passing <= 8) {
    L.push(`> Tradeable universe is very narrow. If names you consider liquid are failing,`);
    L.push(`> the thresholds are calibrated above this venue's actual depth — both are env vars.`);
    L.push('');
  }
  L.push(`Passing: ${lq.passingList.join(', ') || '(none)'}`);
  L.push('');
  if (lq.nearMisses.length) {
    L.push(`Near misses (within 2x of a threshold):`);
    L.push('');
    L.push(`| Asset | 24h vol | vs min | OI | vs min |`, `|---|---|---|---|---|`);
    for (const n of lq.nearMisses) {
      L.push(`| ${n.asset} | ${usdM(n.volUsd)} | ${n.volRatio.toFixed(2)}x | ${usdM(n.oiUsd)} | ${n.oiRatio.toFixed(2)}x |`);
    }
    L.push('');
  }

  L.push(`## 7. Open positions`);
  L.push('');
  if (!rep.positions.length) L.push(`None.`);
  else {
    L.push(`| Asset | Dir | Entry | Mark | Size | Risk | Stop | Target | Trail | Thesis | Conv |`, `|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const x of rep.positions) {
      L.push(`| ${x.asset} | ${x.direction} | ${x.entryPx} | ${x.mark ?? '—'} | ${money(x.notional)} | ${money(x.riskUsd)} | ${x.stopPx} | ${x.targetPx} | ${x.trailArmed ? 'armed' : '—'} | ${x.thesisTag || '—'} | ${x.conviction} |`);
    }
  }
  L.push('');

  L.push(`## 8. Config in force`);
  L.push('');
  L.push(`| Key | Value |`, `|---|---|`);
  for (const k of Object.keys(rep.config).sort()) L.push(`| ${k} | ${rep.config[k]} |`);
  L.push('');

  L.push(`## 9. Agent reachability`);
  L.push('');
  const ss = Object.entries(rep.siblingStatus);
  L.push(ss.length ? ss.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'no sibling calls recorded yet');
  L.push('');
  if (rep.errors.length) {
    L.push(`Recent errors:`);
    L.push('');
    for (const e of rep.errors) L.push(`- ${e.time} — ${e.message}`);
    L.push('');
  }

  L.push(`## 10. Closed trades`);
  L.push('');
  if (!rep.trades.length) L.push(`None.`);
  else {
    L.push(`| Asset | Dir | Entry → Exit | R | P&L | Reason | Held | Vizier | Thesis | Conv |`, `|---|---|---|---|---|---|---|---|---|---|`);
    for (const t of rep.trades) {
      L.push(`| ${t.asset} | ${t.direction} | ${t.entryPx} → ${t.exitPx} | ${rfmt(t.r)} | ${money(t.pnl)} | ${t.reason} | ${hrs(t.heldHours)} | ${t.vizier} | ${t.thesisTag || '—'} | ${t.conviction ?? '—'} |`);
    }
    if (rep.tradesTruncated) L.push('', `_${rep.tradesTruncated} older trades omitted; all aggregates above cover the full set._`);
  }
  L.push('');

  return L.join('\n');
}

// ── mount ────────────────────────────────────────────────────────────────────
function mountWeeklyReport(app, opts = {}) {
  const { getState, getConfig, getScoreboard, getEquityNow } = opts;
  if (!app || typeof app.get !== 'function') throw new Error('mountWeeklyReport: express app required');
  if (typeof getState !== 'function') throw new Error('mountWeeklyReport: getState required');

  const make = () => buildReport({
    state: getState(),
    config: safe(() => (typeof getConfig === 'function' ? getConfig() : {}), {}),
    scoreboard: safe(() => (typeof getScoreboard === 'function' ? getScoreboard() : {}), {}),
    equityNow: safe(() => (typeof getEquityNow === 'function' ? getEquityNow() : undefined), undefined),
  });

  app.get('/api/report/weekly', (_req, res) => {
    try { res.type('text/plain; charset=utf-8').send(renderMarkdown(make())); }
    catch (e) { res.status(500).type('text/plain').send(`report error: ${e.message}\n\n${e.stack}`); }
  });

  app.get('/api/report/weekly.json', (_req, res) => {
    try { res.json(make()); } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  });

  console.log('[weekly-report] mounted at /api/report/weekly');
}

module.exports = {
  mountWeeklyReport, buildReport, renderMarkdown,
  aggregateByExitReason, analyseDecisions, liquidityGate,
  computeProfitFactor, computeWinRate,
};
