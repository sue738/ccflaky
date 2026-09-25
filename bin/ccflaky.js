#!/usr/bin/env node
/**
 * ccflaky — which tools does Claude actually use, and which ones fail?
 *
 * A failing tool is invisible in normal use: Claude retries, works around it,
 * and you never learn that (say) your test command errors 40% of the time.
 * This counts every tool call and pairs it with its result.
 *
 *   ccflaky              # all time
 *   ccflaky --days 7 --failures
 */
'use strict';

const T = require('../lib/vendor/transcript.js');
const S = require('../lib/flaky.js');
const G = require('../lib/suggest.js');
const R = require('../lib/relapse.js');
const SC = require('../lib/scaffold.js');
const EV = require('../lib/events.js');
const path = require('path');
const os = require('os');
const fs = require('fs');

// English by default (this is a public npm package); same override pattern
// as its sibling ccskillstats, so the two behave consistently.
const JA = /^ja/i.test(process.env.CCFLAKY_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

// feed() gates every entry on T.isMainLoop() by default, so subagent turns
// never reach the counters. Printed next to the totals so the number can be
// compared with tools that made the other choice.
const SCOPE = 'main';

const HELP = `ccflaky — tool usage and failure rates from your transcripts

Usage: ccflaky [options]
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
  --guardable          with --suggest: mark which failures a pre-call guard
                       could actually catch (single cause + input-side)
  --scaffold TOOL      print a PreToolUse hook skeleton for TOOL, with the
                       measured numbers filled in and the condition left as a
                       TODO -- guessing the condition from an error string
                       would block correct calls, which costs more than the
                       failure did
  --watch TOOL         record that you just guarded TOOL; now becomes the
                       cutoff between "before" and "after"
  --verify             for everything watched: failure rate before vs after.
                       This is the step people skip -- a rule gets written and
                       everyone assumes it worked.
  --min-after N        calls needed after a guard before judging (default 20)
  --memory-dir D        --suggest: check each flagged tool's name against
                        *.md files in D, flag whether it's already documented
                        (optional — skipped if not given, keeps this general-
                        purpose rather than baked to one memory layout)`;

// A flag that expects a value (--days, --project, --base-dir) must not
// swallow the *next* flag when its value is missing — `--days --json`
// used to consume "--json" as the day count and silently ignore both
// (found on review: NaN days = no filter, and --json never took effect).
function looksLikeFlag(s) { return typeof s === 'string' && s.startsWith('--'); }

function usageError(msg) { console.error(msg); process.exit(2); }

function parseArgs(argv) {
  const o = {};
  // A flag that takes a value and finds none (end of argv, or another flag)
  // used to be skipped silently: `--days --json` meant all history, and a bare
  // `--watch` printed the summary without registering anything.
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || looksLikeFlag(v)) usageError(L(`${flag}: expected a value`, `${flag}: 値を指定してください`));
    return v;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') o.days = +value(i++, a);
    else if (a === '--daily') o.daily = true;
    else if (a === '--project') o.project = value(i++, a);
    else if (a === '--failures') o.failures = true;
    else if (a === '--json') o.json = true;
    else if (a === '--base-dir') o.baseDir = value(i++, a);
    else if (a === '--suggest') o.suggest = true;
    else if (a === '--guardable') o.guardable = true;
    else if (a === '--watch') o.watch = value(i++, a);
    else if (a === '--verify') o.verify = true;
    else if (a === '--scaffold') o.scaffold = value(i++, a);
    else if (a === '--min-after') o.minAfter = +value(i++, a);
    else if (a === '--min-calls') o.minCalls = +value(i++, a);
    else if (a === '--min-rate') o.minRate = +value(i++, a);
    else if (a === '--memory-dir') o.memoryDir = value(i++, a);
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a.startsWith('-')) {
      // 知らないフラグを黙って捨てると、typo(--dyas 1)が「全期間の集計」として
      // 成功し、間違った数字を正しい答えだと思って読むことになる(初見レビューで
      // 実際に踏まれた)。知らないものは受け取らない。
      console.error(L(`unknown option: ${a}`, `知らないオプション: ${a}`));
      console.error(L('try --help', '--help を参照してください'));
      process.exit(2);
    }
  }
  // A malformed number must not read as "nothing" or as the default: --days -3
  // printed no calls, --days abc meant all history, --min-calls abc silently
  // became 5, and --min-after -1 judged a guard on three calls.
  if (o.days != null && !(Number.isFinite(o.days) && o.days > 0)) usageError(L('--days: expected a positive number', '--days: 正の数で指定してください'));
  for (const [k, flag] of [['minCalls', '--min-calls'], ['minAfter', '--min-after']]) {
    if (o[k] != null && !(Number.isInteger(o[k]) && o[k] > 0)) usageError(L(`${flag}: expected a positive whole number`, `${flag}: 正の整数で指定してください`));
  }
  if (o.minRate != null && !(Number.isFinite(o.minRate) && o.minRate > 0 && o.minRate <= 100)) usageError(L('--min-rate: expected a percentage above 0, up to 100', '--min-rate: 0より大きく100以下の%で指定してください'));
  return o;
}

const pad2 = (n) => String(n).padStart(2, '0');
/**
 * Local calendar day 'YYYY-MM-DD'. Transcript timestamps are UTC; slicing the
 * ISO string named the UTC day, so east of UTC anything before the offset hour
 * (09:00 in Tokyo) was counted under the day before.
 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** Local 'YYYY-MM-DD HH:MM' — a guard's start is shown in the reader's own clock. */
function minuteKey(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const makeTracker = S.makeTracker;
const bar = S.bar;
function feed(tr, entry, sinceMs) { return S.feed(T, tr, entry, { scope: SCOPE, sinceMs }); }
function summarize(tr) { return S.summarize(tr, SCOPE); }


// --- guard の投入記録と、その後の再発測定 -------------------------------
// 「規則を書いた」で終わらせないための最小の仕掛け。投入時刻を1つ持てば、
// 履歴側は既にあるので前後比較ができる(事前に基準を取っておく必要がない)。
const MANIFEST = process.env.CCFLAKY_MANIFEST
  || path.join(os.homedir(), '.claude', 'ccflaky-guards.json');

function loadGuards() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).guards || []; }
  catch (e) { return []; }
}
function saveGuards(guards) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({ guards }, null, 2) + '\n');
}

async function collectEvents(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  return EV.collect(T, { baseDir: o.baseDir, project: o.project, sinceMs });
}

async function main() {
  const o = parseArgs(process.argv);

  if (o.watch) {
    const guards = loadGuards().filter((g) => g.tool !== o.watch);
    const at = new Date().toISOString();
    guards.push({ tool: o.watch, installedAt: at });
    saveGuards(guards);
    console.log(L(`watching ${o.watch} from ${minuteKey(Date.parse(at))}`, `${o.watch} を ${minuteKey(Date.parse(at))} から監視します`));
    console.log(L('  Calls before that moment are the baseline; calls after are the test.',
                  '  この時刻より前が基準、後が検証対象です。'));
    return;
  }

  if (o.scaffold) {
    const events = await collectEvents(o);
    const { rows, errors } = (() => {
      const st = new Map(); const errs = [];
      for (const e of events) {
        if (!st.has(e.tool)) st.set(e.tool, { calls: 0, errors: 0 });
        const x = st.get(e.tool); x.calls++;
        if (!e.ok) { x.errors++; errs.push({ tool: e.tool, text: e.text }); }
      }
      return { rows: [...st.entries()].map(([name, x]) => ({ name, calls: x.calls, errors: x.errors,
        errorRate: x.calls ? +((x.errors / x.calls) * 100).toFixed(1) : 0 })), errors: errs };
    })();
    const row = rows.find((r) => r.name === o.scaffold);
    if (!row) { console.error(L(`no calls recorded for ${o.scaffold}`, `${o.scaffold} の呼び出し記録がありません`)); process.exit(2); }
    const clusters = G.cluster(errors.filter((e) => e.tool === o.scaffold));
    const d = R.dominance(clusters);
    console.log(SC.scaffold(o.scaffold, {
      calls: row.calls, errors: row.errors, errorRate: row.errorRate,
      sample: d.top && d.top.sample, share: d.share,
    }));
    return;
  }

  if (o.verify) {
    const guards = loadGuards();
    // --json always answers in JSON: the empty result, not a sentence.
    if (!guards.length && o.json) return console.log(JSON.stringify({ results: [] }, null, 2));
    if (!guards.length) {
      return console.log(L('(nothing watched yet — add a guard, then: ccflaky --watch <tool>)',
                           '(監視対象なし — ガードを入れたら ccflaky --watch <tool>)'));
    }
    const events = await collectEvents(o);
    const results = guards.map((g) => {
      const rates = R.ratesAround(events, { tool: g.tool, cutoffMs: Date.parse(g.installedAt) });
      return { ...g, ...rates, ...R.verdict(rates, { minAfterCalls: o.minAfter }) };
    });
    if (o.json) return console.log(JSON.stringify({ results }, null, 2));
    const ICON = { fixed: '✔', improved: '↓', unchanged: '=', worse: '✗', insufficient: '?', 'no-baseline': '?' };
    console.log('=== ccflaky --verify ===');
    for (const r of results) {
      const since = Date.parse(r.installedAt);
      console.log(`\n  ${ICON[r.verdict] || '?'} ${r.tool}  ${L('since', '開始')} ${Number.isNaN(since) ? r.installedAt : minuteKey(since)}`);
      const fmtSide = (b) => `${b.calls} calls, ${b.errors} err` + (b.rate == null ? '' : ` (${b.rate.toFixed(1)}%)`);
      console.log(`      ${L('before', '投入前')}: ${fmtSide(r.before)}`);
      console.log(`      ${L('after', '投入後')}:  ${fmtSide(r.after)}`);
      console.log(`      ${r.verdict}: ${r.note}`);
    }
    console.log(L('\n  A drop with fewer calls is not a fix — read the call counts, not just the rate.',
                  '\n  呼出が減っての低下は改善ではない。率だけでなく呼出数も見ること。'));
    return;
  }
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
        const day = Number.isNaN(t) ? e.timestamp.slice(0, 10) : dayKey(t);
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
    console.log(`=== ccflaky --daily ===`);
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
      // 「呼ぶ前に止められる型か」の判定。閾値を超えた全部にガードを書くのは
      // 割に合わない — 原因が単一に収束していて、かつ入力側の問題のものだけ。
      const guard = o.guardable ? R.guardCandidate(f) : null;
      return { ...f, documented, ...(guard ? { guardable: guard.candidate, guardReason: guard.reason } : {}) };
    });
    if (o.json) return console.log(JSON.stringify({ minCalls: o.minCalls || 5, minRate: o.minRate || 20, tools: withDocFlag }, null, 2));
    if (!withDocFlag.length) return console.log(L('(no tools crossed the threshold)', '(閾値を超えたツールなし)'));
    console.log(`=== ccflaky --suggest ${o.days ? `(last ${o.days}d)` : ''} ===`);
    for (const f of withDocFlag) {
      const docNote = f.documented === null ? '' : f.documented ? L('  [already documented]', '  [記録済み]') : L('  [NOT documented]', '  [未記録]');
      const mark = o.guardable ? (f.guardable ? '✔ ' : '· ') : '';
      console.log(`\n  ${mark}${f.name}  ${f.calls} calls, ${f.errors} errors (${f.errorRate}%)${docNote}`);
      for (const c of f.clusters) {
        console.log(`    ${String(c.count).padStart(3)}x  ${c.sample.slice(0, 100)}`);
      }
      if (o.guardable) {
        console.log(`      → ${f.guardReason}`);
        if (f.guardable) console.log(`      → ${L('write the guard, then:', 'ガードを書いたら:')} ccflaky --watch ${f.name}`);
      }
    }
    return;
  }

  if (o.json) return console.log(JSON.stringify(s, null, 2));
  if (!s.rows.length) return console.log(L('(no tool calls recorded)', '(ツール実行の記録なし)'));

  const max = s.rows[0].calls;
  console.log(`=== ccflaky ${o.days ? `(last ${o.days}d)` : ''} — ${s.total} calls, ${s.errorRate}% error ===`);
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
