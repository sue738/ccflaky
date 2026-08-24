#!/usr/bin/env node
/**
 * cctoolstat — which tools does Claude actually use, and which ones fail?
 *
 * A failing tool is invisible in normal use: Claude retries, works around it,
 * and you never learn that (say) your test command errors 40% of the time.
 * This counts every tool call and pairs it with its result.
 *
 *   cctoolstat              # all time
 *   cctoolstat --days 7 --failures
 */
'use strict';

const T = require('../lib/vendor/transcript.js');
const S = require('../lib/toolstat.js');
const G = require('../lib/suggest.js');
const fs = require('fs');

// English by default (this is a public npm package); same override pattern
// as its sibling ccskillstats, so the two behave consistently.
const JA = /^ja/i.test(process.env.CCTOOLSTAT_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

// feed() gates every entry on T.isMainLoop() by default, so subagent turns
// never reach the counters. Printed next to the totals so the number can be
// compared with tools that made the other choice.
const SCOPE = 'main';

const HELP = `cctoolstat — tool usage and failure rates from your transcripts

Usage: cctoolstat [options]
  --days N       last N days only
  --daily        per-day breakdown (table by default, --json for machine-readable)
  --project S    only projects matching S
  --failures     show failing calls' error snippets
  --json
  --base-dir D

  --suggest            which tools cross a failure threshold, with their
                        failures clustered by type (no LLM, deterministic)
  --min-calls N        --suggest threshold: minimum calls to count (default 5)
  --min-rate N         --suggest threshold: minimum error rate % (default 20)
  --memory-dir D        --suggest: check each flagged tool's name against
                        *.md files in D, flag whether it's already documented
                        (optional — skipped if not given, keeps this general-
                        purpose rather than baked to one memory layout)`;

// A flag that expects a value (--days, --project, --base-dir) must not
// swallow the *next* flag when its value is missing — `--days --json`
// used to consume "--json" as the day count and silently ignore both
// (found on review: NaN days = no filter, and --json never took effect).
function looksLikeFlag(s) { return typeof s === 'string' && s.startsWith('--'); }

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') { if (!looksLikeFlag(argv[i + 1])) o.days = +argv[++i]; }
    else if (a === '--daily') o.daily = true;
    else if (a === '--project') { if (!looksLikeFlag(argv[i + 1])) o.project = argv[++i]; }
    else if (a === '--failures') o.failures = true;
    else if (a === '--json') o.json = true;
    else if (a === '--base-dir') { if (!looksLikeFlag(argv[i + 1])) o.baseDir = argv[++i]; }
    else if (a === '--suggest') o.suggest = true;
    else if (a === '--min-calls') { if (!looksLikeFlag(argv[i + 1])) o.minCalls = +argv[++i]; }
    else if (a === '--min-rate') { if (!looksLikeFlag(argv[i + 1])) o.minRate = +argv[++i]; }
    else if (a === '--memory-dir') { if (!looksLikeFlag(argv[i + 1])) o.memoryDir = argv[++i]; }
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  }
  return o;
}

const makeTracker = S.makeTracker;
const bar = S.bar;
function feed(tr, entry, sinceMs) { return S.feed(T, tr, entry, { scope: SCOPE, sinceMs }); }
function summarize(tr) { return S.summarize(tr, SCOPE); }

async function main() {
  const o = parseArgs(process.argv);
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({
    baseDir: o.baseDir, project: o.project,
    sinceMs,
  });

  if (o.daily) {
    // 日別バケット。1本のfeed()ループで済ませ、entryのtimestampの日付で
    // トラッカーを振り分ける — ファイル単位ではなくエントリ単位で切るのは
    // 1ファイルが複数日にまたがるセッションがあるため(実測: 珍しくない)。
    // pending(tool_use→name)は全日で共有する — 日ごとに別だと、23:59の
    // 呼び出しに0:01のtool_resultが来た時に前日側の呼び出しを見つけられず
    // 'unknown'に化ける(レビューで発見)。
    const byDay = new Map();
    const sharedPending = new Map();
    for (const f of files) {
      for await (const e of T.readEntries(f.file)) {
        if (!e.timestamp || typeof e.timestamp !== 'string') continue;
        // T.locate の sinceMs はファイルmtime基準の粗いフィルタで、1ファイルが
        // 複数日またがると要求より古い日のバケットまで出てくる(実測:
        // --days 30 のはずが45日分出た)。entry自身のtimestampでも下限を切る。
        const t = Date.parse(e.timestamp);
        if (sinceMs !== undefined && (Number.isNaN(t) || t < sinceMs)) continue;
        const day = e.timestamp.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, makeTracker(sharedPending));
        feed(byDay.get(day), e, sinceMs);
      }
    }
    const daily = [...byDay.entries()].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([date, tr]) => ({ date, ...summarize(tr) }))
      // totalは「その日に発生した呼び出し」の合計で、エラーは呼び出しと
      // 別の日に着地しうる(共有pendingの効果)。total>0だけで絞ると、
      // 呼び出しが前日にある日またぎエラーだけの日が消えて再び見えなくなる。
      .filter((d) => d.total > 0 || d.totalErr > 0);
    if (o.json) return console.log(JSON.stringify({ scope: SCOPE, daily }, null, 2));
    console.log(`=== cctoolstat --daily ===`);
    for (const d of daily) {
      // total=0だけどtotalErr>0の日は「呼び出しは前日、結果(エラー)は
      // この日」という日またぎケース — %表示だと0/0で消えるので件数で出す。
      const rate = d.total > 0 ? `${d.errorRate}% error` : `${d.totalErr} error(s) from a call on a previous day`;
      console.log(`  ${d.date}  ${String(d.total).padStart(5)} calls  ${rate}`);
    }
    return;
  }

  // T.locate の sinceMs はファイルのmtimeでしか絞れない。1ファイルが複数日
  // またがるセッションは珍しくないので(--daily側のコメント参照)、ファイル内の
  // 個々のentryもtimestampで絞らないと、「--days 1」が実質「最後の書き込みが
  // 24時間以内のファイル全体」になり集計期間がラベルと一致しなくなる
  // (レビューで発見: 実測で当日1.73倍・30日平均が実質45日相当)。
  //
  // ただしentry自体をfeed()に渡す前に間引くと、sinceMsのちょうど境界で
  // tool_useだけが窓の外・対応するtool_resultが窓の内、という組が
  // 呼び出し元を見失いunknown・calls=0のエラーとして化ける(レビューで発見)。
  // 全entryをfeed()には渡し、計上そのものをsinceMsでfeed()内部が絞る —
  // pending登録(呼び出しと結果の対応付け)は窓の外でも行われる。
  const tr = makeTracker();
  for (const f of files) for await (const e of T.readEntries(f.file)) feed(tr, e, sinceMs);
  const s = summarize(tr);

  if (o.suggest) {
    const flagged = G.suggest(s.rows, tr.errors, { minCalls: o.minCalls, minRate: o.minRate });
    // memoryDirは任意 — 汎用ツールに特定の個人メモリ配置を焼き込まない
    // (指定された時だけ、そのツール名が既にどこかのmdファイルに出てくるか grep する)。
    let memoryFiles = null;
    if (o.memoryDir) {
      try { memoryFiles = fs.readdirSync(o.memoryDir).filter((f) => f.endsWith('.md')); } catch (e) { memoryFiles = []; }
    }
    const withDocFlag = flagged.map((f) => {
      let documented = null;
      if (memoryFiles) {
        const shortName = f.name.split('__').pop();
        documented = memoryFiles.some((mf) => {
          try {
            const content = fs.readFileSync(`${o.memoryDir}/${mf}`, 'utf8');
            return content.includes(f.name) || content.includes(shortName);
          } catch (e) { return false; }
        });
      }
      return { ...f, documented };
    });
    if (o.json) return console.log(JSON.stringify({ minCalls: o.minCalls || 5, minRate: o.minRate || 20, tools: withDocFlag }, null, 2));
    if (!withDocFlag.length) return console.log(L('(no tools crossed the threshold)', '(閾値を超えたツールなし)'));
    console.log(`=== cctoolstat --suggest ${o.days ? `(last ${o.days}d)` : ''} ===`);
    for (const f of withDocFlag) {
      const docNote = f.documented === null ? '' : f.documented ? L('  [already documented]', '  [記録済み]') : L('  [NOT documented]', '  [未記録]');
      console.log(`\n  ${f.name}  ${f.calls} calls, ${f.errors} errors (${f.errorRate}%)${docNote}`);
      for (const c of f.clusters) {
        console.log(`    ${String(c.count).padStart(3)}x  ${c.sample.slice(0, 100)}`);
      }
    }
    return;
  }

  if (o.json) return console.log(JSON.stringify(s, null, 2));
  if (!s.rows.length) return console.log(L('(no tool calls recorded)', '(ツール実行の記録なし)'));

  const max = s.rows[0].calls;
  console.log(`=== cctoolstat ${o.days ? `(last ${o.days}d)` : ''} — ${s.total} calls, ${s.errorRate}% error ===`);
  console.log(`${L('scope', '集計範囲')}: ${T.scopeNote(s.scope, JA)}\n`);
  for (const r of s.rows) {
    const err = r.errors ? `  ⚠️ ${r.errors} err (${r.errorRate}%)` : '';
    console.log(`  ${r.name.padEnd(18)} ${String(r.calls).padStart(5)} ${bar(r.calls, max, 24)}${err}`);
  }
  if (o.failures && tr.errors.length) {
    console.log(L('\n--- inside the failures (last 10) ---', '\n--- 失敗の中身 (最新10件) ---'));
    for (const e of tr.errors.slice(-10)) console.log(`  [${e.tool}] ${e.text}`);
  } else if (tr.errors.length) {
    console.log(L(`\n(--failures shows the content of ${tr.errors.length} failures)`,
      `\n(--failures で失敗 ${tr.errors.length} 件の中身を表示)`));
  }
}

if (require.main === module) main();
module.exports = { makeTracker, feed, summarize, bar };
