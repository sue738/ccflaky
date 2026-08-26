'use strict';

/**
 * toolstat.js — tool call / error pairing, shared with ccinside's probe.js so
 * "tool error rate" has one implementation instead of two that can drift
 * apart silently. See docs/cc-tools-inventory.md for the 2.3x discrepancy
 * this fixed (cctoolstats undercounted because it never scanned subagent
 * transcripts; the root cause was in cctranscript.locate(), already fixed
 * there — this module just stops there being a second measurement to drift).
 *
 * Default scope stays 'main' so cctoolstats's own output is unchanged.
 * ccinside passes scope:'both' to include subagent turns.
 */

/**
 * Pair tool_use blocks with their tool_result by id.
 * Pure and streaming-friendly: feed entries in order.
 */
// sharedPending lets callers that split entries across several trackers
// (cctoolstats --daily buckets by day) still resolve a tool_result whose
// tool_use landed in a different bucket — e.g. a call at 23:59 and its
// result at 00:01 next day. Without a shared map the result can't find its
// tool_use's name, silently miscounts as 'unknown', and the call's own
// bucket shows 0 errors for a call that actually failed (found on review).
function makeTracker(sharedPending) {
  return { pending: sharedPending || new Map(), stats: {}, errors: [] };
}

function bump(stats, name) {
  if (!stats[name]) stats[name] = { calls: 0, errors: 0 };
  return stats[name];
}

function feed(T, tr, entry, opts) {
  const scope = (opts && opts.scope) || 'main';
  const sinceMs = opts && opts.sinceMs;
  // sinceMs より前の呼び出しでも pending には常に登録する。呼び出し側が
  // sinceMs より前のentryをそもそもfeed()に渡さない実装だと、呼び出しは
  // 窓の外・結果は窓の内、というちょうど境界をまたぐ組が「呼び出し元を
  // 見失ったunknown・calls=0のエラー」として化ける(レビューで発見)。
  // 呼び出しの計上(calls++)だけをsinceMsで絞り、pending登録は絞らない。
  const inWindow = sinceMs === undefined || !entry.timestamp
    || Date.parse(entry.timestamp) >= sinceMs;
  if (scope === 'main' && !T.isMainLoop(entry)) return;
  if (T.isAssistant(entry)) {
    for (const u of T.toolUsesOf(entry)) {
      if (inWindow) bump(tr.stats, u.name || 'unknown').calls++;
      // pendingには呼び出し元のstats(=呼び出しが計上されたバケット)への参照も
      // 一緒に持たせる。日をまたいでtool_resultが別バケットに来た時、その
      // バケットのstatsにerrors++すると「呼び出しは前日、結果はこの日」の
      // callがerrorRate計算上どちらの日にも正しく現れない
      // (calls=1,errors=0の日とcalls=0,errors=1の日に分裂し、両方0%になる —
      // レビューで発見・再現)。エラーは呼び出し元のバケットに計上する。
      if (u.id) tr.pending.set(u.id, { name: u.name || 'unknown', stats: tr.stats });
    }
    return;
  }
  if (!T.isUser(entry)) return;
  for (const b of T.blocksOf(entry)) {
    if (b.type !== 'tool_result') continue;
    const p = b.tool_use_id ? tr.pending.get(b.tool_use_id) : null;
    const name = p ? p.name : null;
    if (b.tool_use_id) tr.pending.delete(b.tool_use_id);
    if (!b.is_error || !inWindow) continue;
    const s = bump(p ? p.stats : tr.stats, name || 'unknown');
    s.errors++;
    const c = b.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';
    tr.errors.push({ tool: name || 'unknown', text: String(text).replace(/\s+/g, ' ').slice(0, 160) });
  }
}

function summarize(tr, scope) {
  const rows = Object.entries(tr.stats).map(([name, s]) => ({
    name, calls: s.calls, errors: s.errors,
    errorRate: s.calls ? +((s.errors / s.calls) * 100).toFixed(1) : 0,
  })).sort((a, b) => b.calls - a.calls);
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const totalErr = rows.reduce((a, r) => a + r.errors, 0);
  return { scope: scope || 'main', rows, total, totalErr, errorRate: total ? +((totalErr / total) * 100).toFixed(1) : 0 };
}

function bar(n, max, w) {
  const filled = max ? Math.round((n / max) * w) : 0;
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, w - filled));
}

module.exports = { makeTracker, feed, summarize, bar };
