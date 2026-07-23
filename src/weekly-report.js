'use strict';

/**
 * weekly-report.js — SUPREME-LEADER weekly report generator
 * v1.0 · SUPREME-LEADER state only (no cross-agent hub calls)
 *
 * Mounts:
 *   GET  /api/report/weekly        → markdown as text/plain (paste straight into chat)
 *   GET  /api/report/weekly.json   → same data, structured
 *   POST /api/report/weekly/send   → dispatch via Herald SMTP now
 *
 * Also schedules a Sunday 09:00 Europe/Istanbul email (= 06:00 UTC, no DST in TR).
 *
 * Usage in src/index.js — add these two lines AFTER `app` and your state exist:
 *
 *   const { mountWeeklyReport } = require('./weekly-report');
 *   mountWeeklyReport(app, { getState: () => STATE, sendMail: sendHeraldMail });
 *
 * `getState` must return an object; see ADAPTER below for the field names it
 * reads. `sendMail` is optional — omit it and the email schedule is skipped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER — the ONLY block you should need to edit.
// Each function receives your state object and returns the piece of data named.
// If a field does not exist in your state, return the fallback shown and that
// section will render as "not available" instead of crashing the report.
// ─────────────────────────────────────────────────────────────────────────────
const ADAPTER = {
  equity:        (s) => num(s.equity, 0),
  startEquity:   (s) => num(s.startEquity ?? s.startingEquity, 100),
  realizedPnl:   (s) => num(s.realizedPnl ?? s.realizedPnL, 0),
  unrealizedPnl: (s) => num(s.unrealizedPnl ?? s.unrealizedPnL, 0),
  fees:          (s) => num(s.fees ?? s.totalFees, 0),
  dayCount:      (s) => num(s.dayCount ?? s.days, 0),
  cycleCount:    (s) => num(s.cycleCount ?? s.cycles, 0),

  openPositions: (s) => arr(s.openPositions ?? s.positions),
  closedTrades:  (s) => arr(s.closedTrades ?? s.trades ?? s.executedTrades),
  courtRecord:   (s) => arr(s.courtRecord ?? s.decisions),

  // Current thresholds in force. Point these at wherever your constants live.
  config:        (s) => obj(s.config ?? s.constitution ?? s.CONFIG),

  // Deploys / KAIZEN task decisions, newest first. Optional.
  changeLog:     (s) => arr(s.changeLog ?? s.deployLog),
};

// Field names read off each closed trade. Edit if yours differ.
const TRADE_FIELDS = {
  asset:     (t) => t.asset ?? t.symbol ?? '?',
  side:      (t) => (t.side ?? t.direction ?? '').toString().toUpperCase(),
  entry:     (t) => t.entry ?? t.entryPrice,
  exit:      (t) => t.exit ?? t.exitPrice,
  r:         (t) => num(t.r ?? t.rMultiple, NaN),
  pnl:       (t) => num(t.pnl ?? t.pnL ?? t.profit, NaN),
  reason:    (t) => t.reason ?? t.exitReason ?? 'UNKNOWN',
  heldHours: (t) => num(t.heldHours ?? t.held ?? t.holdHours, NaN),
  vizier:    (t) => t.vizier ?? t.vizierVerdict ?? '',
  thesisTag: (t) => t.thesisTag ?? t.thesis ?? '',
  closedAt:  (t) => t.closedAt ?? t.exitTime ?? t.timestamp ?? null,
};

// Field names read off each court-record decision. Edit if yours differ.
const DECISION_FIELDS = {
  cycleId: (d) => d.cycleId ?? d.cycle ?? d.cycleNumber ?? null,
  symbol:  (d) => d.symbol ?? d.asset ?? '?',
  verdict: (d) => d.verdict ?? d.status ?? (d.executed ? 'EXECUTED' : 'VETOED'),
  vetoes:  (d) => arr(d.vetoes ?? d.vetoReasons ?? (d.veto ? [d.veto] : [])),
  ts:      (d) => d.ts ?? d.timestamp ?? d.at ?? null,
};

const MAX_TRADE_ROWS = 60;   // full table caps here; aggregates stay unbounded
const WINDOW_DAYS    = 7;

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function num(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function money(v) { return Number.isFinite(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}` : '—'; }
function pct(v, d = 2) { return Number.isFinite(v) ? `${v.toFixed(d)}%` : '—'; }
function rfmt(v) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—'; }
function hrs(v) { return Number.isFinite(v) ? `${v.toFixed(1)}h` : '—'; }
function iso(v) { const d = v ? new Date(v) : null; return (d && !isNaN(d)) ? d.toISOString() : null; }

function safe(fn, fb) { try { const r = fn(); return r === undefined ? fb : r; } catch { return fb; } }

// ─────────────────────────────────────────────────────────────────────────────
// core computation
// ─────────────────────────────────────────────────────────────────────────────
function computeProfitFactor(trades) {
  let gp = 0, gl = 0;
  for (const t of trades) {
    const p = TRADE_FIELDS.pnl(t);
    if (!Number.isFinite(p)) continue;
    if (p >= 0) gp += p; else gl += Math.abs(p);
  }
  return { grossProfit: gp, grossLoss: gl, profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0) };
}

/**
 * Win rate. A trade closing at exactly 0.00 is a SCRATCH — it is excluded from
 * the denominator rather than credited as a win or charged as a loss. Counting
 * scratches either way distorts the rate; reporting them separately does not.
 */
function computeWinRate(trades) {
  const scored = trades.filter((t) => Number.isFinite(TRADE_FIELDS.pnl(t)));
  const wins     = scored.filter((t) => TRADE_FIELDS.pnl(t) > 0).length;
  const losses   = scored.filter((t) => TRADE_FIELDS.pnl(t) < 0).length;
  const scratches = scored.filter((t) => TRADE_FIELDS.pnl(t) === 0).length;
  const decisive = wins + losses;
  return {
    wins, losses, scratches, n: scored.length,
    winRate: decisive ? (wins / decisive) * 100 : NaN,
  };
}

function computeMaxDrawdown(trades, startEquity) {
  const chron = trades
    .slice()
    .sort((a, b) => new Date(TRADE_FIELDS.closedAt(a) || 0) - new Date(TRADE_FIELDS.closedAt(b) || 0));
  let eq = startEquity, peak = startEquity, maxDd = 0;
  for (const t of chron) {
    const p = TRADE_FIELDS.pnl(t);
    if (!Number.isFinite(p)) continue;
    eq += p;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Count, avg R, and total P&L grouped by exit reason. */
function aggregateByExitReason(trades) {
  const byReason = new Map();
  for (const t of trades) {
    const key = TRADE_FIELDS.reason(t);
    if (!byReason.has(key)) byReason.set(key, { reason: key, count: 0, rSum: 0, rN: 0, pnl: 0 });
    const row = byReason.get(key);
    row.count += 1;
    const r = TRADE_FIELDS.r(t);
    if (Number.isFinite(r)) { row.rSum += r; row.rN += 1; }
    const p = TRADE_FIELDS.pnl(t);
    if (Number.isFinite(p)) row.pnl += p;
  }
  return [...byReason.values()]
    .map((r) => ({ ...r, avgR: r.rN ? r.rSum / r.rN : NaN }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Veto funnel + the duplication diagnostic.
 *
 * `rawRows` is the length of the court-record array as stored.
 * `distinctDecisions` collapses on (cycleId, symbol, verdict).
 * If these diverge sharply the duplication is real in the DATA; if they match
 * while the dashboard shows a much larger number, the duplication is in the
 * client-side render.
 */
function analyseCourtRecord(decisions) {
  const seen = new Set();
  const vetoCounts = new Map();
  const byCycle = new Map();
  let executed = 0, vetoed = 0;

  for (const d of decisions) {
    const cycleId = DECISION_FIELDS.cycleId(d);
    const symbol = DECISION_FIELDS.symbol(d);
    const verdict = String(DECISION_FIELDS.verdict(d)).toUpperCase();
    const key = `${cycleId}|${symbol}|${verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (verdict.includes('EXEC')) executed += 1; else vetoed += 1;

    if (cycleId !== null && cycleId !== undefined) {
      if (!byCycle.has(cycleId)) byCycle.set(cycleId, { cycleId, candidates: 0, executed: 0 });
      const c = byCycle.get(cycleId);
      c.candidates += 1;
      if (verdict.includes('EXEC')) c.executed += 1;
    }

    for (const v of DECISION_FIELDS.vetoes(d)) {
      const label = typeof v === 'string' ? v : (v && (v.reason ?? v.code ?? v.type)) || 'UNKNOWN';
      vetoCounts.set(label, (vetoCounts.get(label) || 0) + 1);
    }
  }

  const cycles = [...byCycle.values()].sort((a, b) => Number(b.cycleId) - Number(a.cycleId));

  return {
    rawRows: decisions.length,
    distinctDecisions: seen.size,
    duplicationRatio: seen.size ? decisions.length / seen.size : 0,
    executed,
    vetoed,
    executionRate: seen.size ? (executed / seen.size) * 100 : NaN,
    vetoBreakdown: [...vetoCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    recentCycles: cycles.slice(0, 10),
  };
}

function withinWindow(t, days) {
  const at = TRADE_FIELDS.closedAt(t);
  if (!at) return false;
  const d = new Date(at);
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) <= days * 86400000;
}

// ─────────────────────────────────────────────────────────────────────────────
// report assembly
// ─────────────────────────────────────────────────────────────────────────────
function buildReport(state) {
  const s = obj(state);

  const equity        = safe(() => ADAPTER.equity(s), 0);
  const startEquity   = safe(() => ADAPTER.startEquity(s), 100);
  const realizedPnl   = safe(() => ADAPTER.realizedPnl(s), 0);
  const unrealizedPnl = safe(() => ADAPTER.unrealizedPnl(s), 0);
  const fees          = safe(() => ADAPTER.fees(s), 0);
  const dayCount      = safe(() => ADAPTER.dayCount(s), 0);
  const cycleCount    = safe(() => ADAPTER.cycleCount(s), 0);

  const openPositions = safe(() => ADAPTER.openPositions(s), []);
  const closedTrades  = safe(() => ADAPTER.closedTrades(s), []);
  const courtRecord   = safe(() => ADAPTER.courtRecord(s), []);
  const config        = safe(() => ADAPTER.config(s), {});
  const changeLog     = safe(() => ADAPTER.changeLog(s), []);

  const allTime = {
    ...computeProfitFactor(closedTrades),
    ...computeWinRate(closedTrades),
    maxDrawdown: computeMaxDrawdown(closedTrades, startEquity),
    trades: closedTrades.length,
  };

  const windowTrades = closedTrades.filter((t) => withinWindow(t, WINDOW_DAYS));
  const thisWeek = {
    ...computeProfitFactor(windowTrades),
    ...computeWinRate(windowTrades),
    trades: windowTrades.length,
    hasTimestamps: windowTrades.length > 0 || closedTrades.every((t) => !TRADE_FIELDS.closedAt(t)) === false,
  };

  const openRisk = openPositions.reduce((acc, p) => {
    const size = num(p.size ?? p.notional, NaN);
    const entry = num(p.entry ?? p.entryPrice, NaN);
    const stop = num(p.stop ?? p.stopPrice, NaN);
    if (![size, entry, stop].every(Number.isFinite) || entry === 0) return acc;
    return acc + Math.abs(size * ((entry - stop) / entry));
  }, 0);

  const netDelta = openPositions.reduce((acc, p) => {
    const size = num(p.size ?? p.notional, 0);
    const side = String(p.side ?? p.direction ?? '').toUpperCase();
    return acc + (side.includes('SHORT') ? -size : size);
  }, 0);

  return {
    generatedAt: new Date().toISOString(),
    version: '1.0',
    scope: 'SUPREME-LEADER only',
    windowDays: WINDOW_DAYS,

    performance: {
      equity, startEquity,
      totalReturnPct: startEquity ? ((equity - startEquity) / startEquity) * 100 : NaN,
      realizedPnl, unrealizedPnl, fees, dayCount, cycleCount,
    },
    allTime,
    thisWeek,

    graduation: {
      trades:       { value: allTime.trades,      gate: 30,   pass: allTime.trades >= 30 },
      profitFactor: { value: allTime.profitFactor, gate: 1.2, pass: allTime.profitFactor > 1.2 },
      drawdown:     { value: allTime.maxDrawdown,  gate: 15,  pass: allTime.maxDrawdown < 15 },
      days:         { value: dayCount,             gate: 21,  pass: dayCount >= 21 },
    },

    exitReasons: aggregateByExitReason(closedTrades),
    courtRecordAnalysis: analyseCourtRecord(courtRecord),

    openBook: {
      count: openPositions.length,
      totalRiskUsd: openRisk,
      riskPctOfEquity: equity ? (openRisk / equity) * 100 : NaN,
      netDeltaUsd: netDelta,
      netDeltaXEquity: equity ? netDelta / equity : NaN,
      positions: openPositions,
    },

    config,
    changeLog: changeLog.slice(0, 20),

    trades: closedTrades
      .slice()
      .sort((a, b) => new Date(TRADE_FIELDS.closedAt(b) || 0) - new Date(TRADE_FIELDS.closedAt(a) || 0))
      .slice(0, MAX_TRADE_ROWS)
      .map((t) => ({
        asset: TRADE_FIELDS.asset(t),
        side: TRADE_FIELDS.side(t),
        entry: TRADE_FIELDS.entry(t),
        exit: TRADE_FIELDS.exit(t),
        r: TRADE_FIELDS.r(t),
        pnl: TRADE_FIELDS.pnl(t),
        reason: TRADE_FIELDS.reason(t),
        heldHours: TRADE_FIELDS.heldHours(t),
        vizier: TRADE_FIELDS.vizier(t),
        thesisTag: TRADE_FIELDS.thesisTag(t),
        closedAt: iso(TRADE_FIELDS.closedAt(t)),
      })),
    tradesTruncated: Math.max(0, closedTrades.length - MAX_TRADE_ROWS),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// markdown rendering
// ─────────────────────────────────────────────────────────────────────────────
function renderMarkdown(rep) {
  const L = [];
  const p = rep.performance;
  const pfTxt = (v) => (v === Infinity ? '∞' : Number.isFinite(v) ? v.toFixed(2) : '—');

  L.push(`# SUPREME-LEADER — Weekly Report`);
  L.push(`Generated ${rep.generatedAt} · v${rep.version} · scope: ${rep.scope}`);
  L.push('');

  L.push(`## 1. Headline`);
  L.push('');
  L.push(`| Metric | Value |`);
  L.push(`|---|---|`);
  L.push(`| Equity | ${money(p.equity)} (start ${money(p.startEquity)}, ${pct(p.totalReturnPct)}) |`);
  L.push(`| Realized P&L | ${money(p.realizedPnl)} |`);
  L.push(`| Unrealized P&L | ${money(p.unrealizedPnl)} |`);
  L.push(`| Fees paid | ${money(p.fees)} |`);
  L.push(`| Closed trades | ${rep.allTime.trades} |`);
  L.push(`| Win rate | ${pct(rep.allTime.winRate, 1)} (${rep.allTime.wins}W / ${rep.allTime.losses}L${rep.allTime.scratches ? ` / ${rep.allTime.scratches} scratch` : ''}) |`);
  L.push(`| Profit factor | ${pfTxt(rep.allTime.profitFactor)} |`);
  L.push(`| Max drawdown | ${pct(rep.allTime.maxDrawdown)} |`);
  L.push(`| Day / cycle | ${p.dayCount} / #${p.cycleCount} |`);
  L.push('');

  L.push(`### This week (last ${rep.windowDays}d)`);
  L.push('');
  if (!rep.thisWeek.trades) {
    L.push(`No closed trades in window (or trades carry no close timestamp).`);
  } else {
    L.push(`${rep.thisWeek.trades} trades · win rate ${pct(rep.thisWeek.winRate, 1)} · PF ${pfTxt(rep.thisWeek.profitFactor)} · gross ${money(rep.thisWeek.grossProfit)} won / ${money(rep.thisWeek.grossLoss)} lost`);
  }
  L.push('');

  L.push(`## 2. Graduation scoreboard`);
  L.push('');
  L.push(`| Gate | Value | Required | |`);
  L.push(`|---|---|---|---|`);
  const g = rep.graduation;
  L.push(`| Trades | ${g.trades.value} | ≥ 30 | ${g.trades.pass ? 'PASS' : 'no'} |`);
  L.push(`| Profit factor | ${pfTxt(g.profitFactor.value)} | > 1.2 | ${g.profitFactor.pass ? 'PASS' : 'no'} |`);
  L.push(`| Max drawdown | ${pct(g.drawdown.value)} | < 15% | ${g.drawdown.pass ? 'PASS' : 'no'} |`);
  L.push(`| Days | ${g.days.value} | ≥ 21 | ${g.days.pass ? 'PASS' : 'no'} |`);
  L.push('');

  L.push(`## 3. Exit-reason breakdown`);
  L.push('');
  if (!rep.exitReasons.length) {
    L.push(`No closed trades.`);
  } else {
    L.push(`| Exit reason | Count | Avg R | Net P&L |`);
    L.push(`|---|---|---|---|`);
    for (const r of rep.exitReasons) {
      L.push(`| ${r.reason} | ${r.count} | ${rfmt(r.avgR)} | ${money(r.pnl)} |`);
    }
  }
  L.push('');

  L.push(`## 4. Decision funnel`);
  L.push('');
  const c = rep.courtRecordAnalysis;
  L.push(`Court record — raw rows: **${c.rawRows}** · distinct decisions: **${c.distinctDecisions}** · ratio: **${c.duplicationRatio.toFixed(2)}x**`);
  L.push('');
  if (c.duplicationRatio > 1.5) {
    L.push(`> Duplication present in stored data (ratio ${c.duplicationRatio.toFixed(2)}x). Server-side writer is re-appending.`);
  } else {
    L.push(`> Stored data is clean. Any inflated count on the dashboard is a client-side render issue, not a write bug.`);
  }
  L.push('');
  L.push(`Executed: ${c.executed} · Vetoed: ${c.vetoed} · Execution rate: ${pct(c.executionRate, 1)}`);
  L.push('');
  if (c.vetoBreakdown.length) {
    L.push(`| Veto reason | Count |`);
    L.push(`|---|---|`);
    for (const v of c.vetoBreakdown) L.push(`| ${v.reason} | ${v.count} |`);
    L.push('');
  }
  if (c.recentCycles.length) {
    L.push(`Recent cycles — ${c.recentCycles.map((x) => `#${x.cycleId}: ${x.executed}/${x.candidates}`).join(' · ')}`);
    L.push('');
  }

  L.push(`## 5. Open book`);
  L.push('');
  const ob = rep.openBook;
  L.push(`${ob.count} positions · risk ${money(ob.totalRiskUsd)} (${pct(ob.riskPctOfEquity)} of equity) · net delta ${money(ob.netDeltaUsd)} (${Number.isFinite(ob.netDeltaXEquity) ? ob.netDeltaXEquity.toFixed(2) : '—'}x equity)`);
  L.push('');

  L.push(`## 6. Config in force`);
  L.push('');
  const keys = Object.keys(rep.config);
  if (!keys.length) {
    L.push(`No config exposed — point ADAPTER.config at your constants object.`);
  } else {
    L.push(`| Key | Value |`);
    L.push(`|---|---|`);
    for (const k of keys.sort()) {
      const v = rep.config[k];
      L.push(`| ${k} | ${typeof v === 'object' ? JSON.stringify(v) : String(v)} |`);
    }
  }
  L.push('');

  L.push(`## 7. Change log`);
  L.push('');
  if (!rep.changeLog.length) {
    L.push(`No entries.`);
  } else {
    for (const e of rep.changeLog) {
      L.push(`- ${typeof e === 'string' ? e : JSON.stringify(e)}`);
    }
  }
  L.push('');

  L.push(`## 8. Closed trades`);
  L.push('');
  if (!rep.trades.length) {
    L.push(`None.`);
  } else {
    L.push(`| Asset | Side | Entry → Exit | R | P&L | Reason | Held | Vizier | Thesis |`);
    L.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const t of rep.trades) {
      L.push(`| ${t.asset} | ${t.side} | ${t.entry} → ${t.exit} | ${rfmt(t.r)} | ${money(t.pnl)} | ${t.reason} | ${hrs(t.heldHours)} | ${t.vizier} | ${t.thesisTag} |`);
    }
    if (rep.tradesTruncated) L.push('', `_${rep.tradesTruncated} older trades omitted; aggregates above cover all._`);
  }
  L.push('');

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// mounting
// ─────────────────────────────────────────────────────────────────────────────
function mountWeeklyReport(app, { getState, sendMail, to } = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('mountWeeklyReport: express app required');
  if (typeof getState !== 'function') throw new Error('mountWeeklyReport: getState function required');

  const make = () => buildReport(getState());

  app.get('/api/report/weekly', (_req, res) => {
    try {
      res.type('text/plain; charset=utf-8').send(renderMarkdown(make()));
    } catch (e) {
      res.status(500).type('text/plain').send(`report error: ${e.message}\n${e.stack}`);
    }
  });

  app.get('/api/report/weekly.json', (_req, res) => {
    try { res.json(make()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/report/weekly/send', async (_req, res) => {
    if (typeof sendMail !== 'function') return res.status(501).json({ error: 'no sendMail provided' });
    try {
      const md = renderMarkdown(make());
      await sendMail({ to, subject: `SUPREME-LEADER weekly report — ${new Date().toISOString().slice(0, 10)}`, text: md });
      res.json({ sent: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sunday 09:00 Europe/Istanbul === Sunday 06:00 UTC (Turkey is UTC+3 year-round).
  if (typeof sendMail === 'function') {
    let lastSentKey = null;
    setInterval(async () => {
      const now = new Date();
      if (now.getUTCDay() !== 0 || now.getUTCHours() !== 6) return;
      const key = now.toISOString().slice(0, 13);
      if (key === lastSentKey) return;
      lastSentKey = key;
      try {
        await sendMail({
          to,
          subject: `SUPREME-LEADER weekly report — ${now.toISOString().slice(0, 10)}`,
          text: renderMarkdown(make()),
        });
        console.log('[weekly-report] sent');
      } catch (e) {
        console.error('[weekly-report] send failed:', e.message);
      }
    }, 60_000).unref?.();
  }

  console.log('[weekly-report] mounted at /api/report/weekly');
}

module.exports = {
  mountWeeklyReport,
  buildReport,
  renderMarkdown,
  aggregateByExitReason,
  analyseCourtRecord,
  computeProfitFactor,
  computeWinRate,
  computeMaxDrawdown,
  ADAPTER,
  TRADE_FIELDS,
  DECISION_FIELDS,
};
