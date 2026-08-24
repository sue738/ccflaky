'use strict';

/**
 * suggest.js — 実測の失敗テキストを「型」ごとにまとめる。パターン要約や
 * 対策の判断(メモリに書くか・hookで防ぐか)はLLM/人間の仕事として残す
 * (HITL既定) — ここでやるのは決定的にできる部分だけ:
 *   1. 閾値(calls/errorRate)を超えたツールの抽出
 *   2. そのツールの失敗テキストを型でクラスタリング(同じ原因の重複を畳む)
 * どちらもLLM呼び出し無しで安定して実行できる。
 */

// 失敗テキストから「型」を抽出する。JSON本体・messageフィールド・素の文字列の
// どれでも、IDや数値のようなインスタンス固有の部分を落として比較可能にする。
function signatureOf(text) {
  const s = String(text || '');
  // codeやnameは短い識別子で、数字も含めて意味を持つ("E1"と"E2"は別の型)
  // — ここは畳まずそのまま型として使う。畳むのはmessage由来の自由文
  // (行番号やUUIDなど、インスタンスごとに変わる部分)だけにする。
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      if (j.code) return String(j.code).slice(0, 100);
      if (j.name) return String(j.name).slice(0, 100);
    }
  } catch (e) { /* not JSON, fall through to free-text handling */ }
  const m = s.match(/"message"\s*:\s*"([^"]{0,120})/);
  const base = m ? m[1] : s;
  return base.slice(0, 100)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+/g, '<n>');
}

function cluster(errors) {
  const groups = new Map();
  for (const e of errors) {
    const sig = signatureOf(e.text);
    if (!groups.has(sig)) groups.set(sig, { signature: sig, count: 0, sample: String(e.text || '').slice(0, 200) });
    groups.get(sig).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * rows: summarize()のrows(name/calls/errors/errorRate)
 * errors: tracker.errors({tool, text})
 * 返り値: 閾値を超えたツールごとに、クラスタリング済みの失敗一覧。
 */
function suggest(rows, errors, opts) {
  const minCalls = (opts && opts.minCalls) || 5;
  const minRate = (opts && opts.minRate) || 20;
  const byTool = new Map();
  for (const e of errors) {
    if (!byTool.has(e.tool)) byTool.set(e.tool, []);
    byTool.get(e.tool).push(e);
  }
  return rows
    .filter((r) => r.calls >= minCalls && r.errorRate >= minRate)
    .map((r) => ({
      name: r.name,
      calls: r.calls,
      errors: r.errors,
      errorRate: r.errorRate,
      clusters: cluster(byTool.get(r.name) || []),
    }))
    .sort((a, b) => b.errorRate - a.errorRate);
}

module.exports = { signatureOf, cluster, suggest };
