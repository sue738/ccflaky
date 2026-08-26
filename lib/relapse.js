'use strict';

/**
 * relapse.js — 「ガードを入れた後、その失敗は本当に止まったか」を測る。
 *
 * 失敗を数えるツールも、hookを配るツールも既にある(ccflaky / ccguardrails)。
 * 抜けているのは最後の一手で、**入れた対策が効いたかを誰も測っていない**。
 * 測らないと、規則を足しただけで直った気になる — 実際、この環境では
 * 「規則は前日から書いてあり、発火しなかった」と記録された日がある
 * (~/.claude/incident-log.md 2026-08-17)。
 *
 * 対照的に、静的検知hookを入れた ScheduleWakeup は投入前6日で29.8%(25/84)、
 * 投入後3日で0.6%(1/176)まで落ちた。呼出数はむしろ倍増しているので
 * 「使わなくなったから減った」ではない。この差を出すのがこのファイルの仕事。
 *
 * 純関数のみ・依存ゼロ。判断(どのガードを入れるか)は人に残す。
 */

// ---------- 1) この失敗は「呼ぶ前に」防げる型か ----------

// 呼び出し側の入力だけで判定できる = PreToolUse hook で止められる。
const INPUT_MARKERS = [
  'must be', 'invalid arguments', 'inputvalidationerror', 'validation_error',
  'is required', 'unrecognized key', 'required parameter', 'expected ',
  'did not match the expected schema', 'unexpected parameter',
];
// 相手側の状態・枠。呼ぶ前の静的検知はできないが、「もう呼ばない」判断はできる。
const QUOTA_MARKERS = ['tool call limit', 'rate limit', 'quota', 'upgrade your', 'too many requests'];
// 認証・セッション。入力を直しても直らない。
const AUTH_MARKERS = ['session expired', 'unauthorized', 'not authenticated', 'invalid token', 'forbidden'];
// 実行時の環境依存(相手のページ・ファイルの有無)。呼ぶ前には分からない。
const STATE_MARKERS = [
  'does not match any elements', 'no such file', 'enoent', 'not found',
  'could not resolve', 'timed out', 'timeout',
];

function classify(cluster) {
  const t = String((cluster && (cluster.sample || cluster.signature)) || '').toLowerCase();
  const hit = (list) => list.find((m) => t.includes(m));

  // 判定順に意味がある: quota/auth は文面に "invalid" 等を含むことがあり、
  // 先に input と判定すると「呼ぶ前に防げる」と誤って言ってしまう。
  let m;
  if ((m = hit(QUOTA_MARKERS))) {
    return { kind: 'quota', guardable: false, reason: `相手側の枠 ("${m}") — 入力を直しても消えない。呼ぶのをやめる判断は可能` };
  }
  if ((m = hit(AUTH_MARKERS))) {
    return { kind: 'auth', guardable: false, reason: `認証/セッション ("${m}") — 呼ぶ前に静的検知できない` };
  }
  if ((m = hit(STATE_MARKERS))) {
    return { kind: 'state', guardable: false, reason: `実行時の環境依存 ("${m}") — 呼ぶ前には分からない` };
  }
  if ((m = hit(INPUT_MARKERS))) {
    return { kind: 'input', guardable: true, reason: `呼び出し側の入力の問題 ("${m}") — PreToolUse で止められる` };
  }
  return { kind: 'unknown', guardable: false, reason: '型を判定できない — 人が読んで決める' };
}

// ---------- 2) 単一パターンに収束しているか ----------

/**
 * ガードは「原因が1つ」のときだけ割に合う。実測でも、静的検知hookを入れた
 * ScheduleWakeup は失敗が全件同一パターンだった一方、notion-create-pages は
 * 14件が5パターンに散っていて、1つ塞いでも残りが出る。
 * dominance = 最頻クラスタが失敗全体に占める割合。
 */
function dominance(clusters) {
  const total = clusters.reduce((s, c) => s + c.count, 0);
  if (!total) return { total: 0, top: null, share: 0 };
  const top = clusters.reduce((a, b) => (b.count > a.count ? b : a));
  return { total, top, share: top.count / total };
}

/**
 * ガード候補か。単一パターンに寄っていて(既定8割)、かつ静的に検知できる型。
 * 閾値を上げ下げできるようにしてあるのは、少ない試行で断定しないため。
 */
function guardCandidate(tool, opts) {
  const minShare = (opts && opts.minShare) != null ? opts.minShare : 0.8;
  const d = dominance(tool.clusters || []);
  if (!d.top) return { candidate: false, reason: '失敗が無い', dominance: d };
  const c = classify(d.top);
  if (d.share < minShare) {
    return {
      candidate: false, dominance: d, classification: c,
      reason: `原因が${(d.share * 100).toFixed(0)}%しか収束していない(閾値${minShare * 100}%) — 1つ塞いでも残りが出る`,
    };
  }
  if (!c.guardable) return { candidate: false, dominance: d, classification: c, reason: c.reason };
  return { candidate: true, dominance: d, classification: c, reason: c.reason };
}

// ---------- 3) 入れた後、止まったか ----------

/**
 * events: [{ ts: msEpoch, tool, ok: bool, text }]
 * 指定のツール(と任意でsignature)について、cutoff前後の失敗率を出す。
 * 「呼出が減っただけ」を成功と誤認しないよう、calls も必ず返す。
 */
function ratesAround(events, { tool, signatureOf, signature, cutoffMs }) {
  const acc = { before: { calls: 0, errors: 0 }, after: { calls: 0, errors: 0 } };
  for (const e of events) {
    if (e.tool !== tool) continue;
    // signature 指定時は「その型の失敗」だけを分子にする。分母(calls)は
    // ツール全体のまま — 型別に呼出数を割り当てることはできないため。
    const bucket = e.ts < cutoffMs ? acc.before : acc.after;
    bucket.calls++;
    if (e.ok) continue;
    if (signature && signatureOf && signatureOf(e.text) !== signature) continue;
    bucket.errors++;
  }
  const rate = (b) => (b.calls ? (b.errors / b.calls) * 100 : null);
  return {
    before: { ...acc.before, rate: rate(acc.before) },
    after: { ...acc.after, rate: rate(acc.after) },
  };
}

/**
 * 判定。数字が出ても、標本が薄ければ「まだ言えない」と言う。
 * ゼロ件を成功と読み替えないための最低呼出数(既定20)を持つ。
 */
function verdict(rates, opts) {
  const minAfterCalls = (opts && opts.minAfterCalls) != null ? opts.minAfterCalls : 20;
  const { before, after } = rates;
  if (before.calls === 0) return { verdict: 'no-baseline', note: '投入前の呼出が無く、比較対象がない' };
  if (after.calls < minAfterCalls) {
    return { verdict: 'insufficient', note: `投入後の呼出が${after.calls}件しかない(最低${minAfterCalls}件) — 0件でも「効いた」とは言えない` };
  }
  const b = before.rate, a = after.rate;
  if (a === 0) return { verdict: 'fixed', note: `${b.toFixed(1)}% → 0%(${after.calls}件中0件)` };
  if (a <= b / 2) return { verdict: 'improved', note: `${b.toFixed(1)}% → ${a.toFixed(1)}%(半減以上)` };
  if (a >= b) return { verdict: 'worse', note: `${b.toFixed(1)}% → ${a.toFixed(1)}% — 効いていない。診断が外れている可能性` };
  return { verdict: 'unchanged', note: `${b.toFixed(1)}% → ${a.toFixed(1)}% — 誤差の範囲` };
}

module.exports = { classify, dominance, guardCandidate, ratesAround, verdict };
