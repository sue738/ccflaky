'use strict';

/**
 * events.js — transcriptから「いつ・どのツールを呼んで・失敗したか」を
 * timestamp付きで取り出す。
 *
 * ccflaky/lib/flaky.js は同じ対応付けをするが、返すのは集計と {tool,text} で
 * **時刻を持たない**。前後比較には時刻が要るので、ここは自前で持つ。
 * 対応付けの構造(tool_use → tool_result を tool_use_id で結ぶ)は flaky.js と
 * 同じにしてある — あちらが実際に踏んだ2つの罠を繰り返さないため:
 *
 *   1. 呼び出しと結果が日をまたぐ。pending は日次バケットで分けず共有する。
 *   2. 窓(sinceMs)の境界。呼び出しが窓外・結果が窓内だと呼び出し元を見失い
 *      'unknown' に化ける。pending への登録だけは窓で絞らない。
 *
 * **時刻は呼び出し側(tool_use)のものを使う。** 結果側にすると、投入した
 * ガードの前に呼ばれた失敗が「投入後」に計上されて効果を過大評価する。
 */

function makeCollector() {
  return { pending: new Map(), events: [] };
}

function feed(T, col, entry, opts) {
  const scope = (opts && opts.scope) || 'main';
  const sinceMs = opts && opts.sinceMs;
  if (scope === 'main' && !T.isMainLoop(entry)) return;

  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const inWindow = sinceMs === undefined || Number.isNaN(ts) || ts >= sinceMs;

  if (T.isAssistant(entry)) {
    for (const u of T.toolUsesOf(entry)) {
      const name = u.name || 'unknown';
      // 呼び出しをその場で1件計上する。結果が返ってこなかった呼び出し
      // (中断・クラッシュ)も分母に入るのが正しい — 「呼んだ」事実は起きている。
      const ev = { ts, tool: name, ok: true, text: '' };
      if (inWindow && !Number.isNaN(ts)) col.events.push(ev);
      // 窓の外でも pending には入れる(上のコメント2の理由)。
      if (u.id) col.pending.set(u.id, ev);
    }
    return;
  }

  if (!T.isUser(entry)) return;
  for (const b of T.blocksOf(entry)) {
    if (b.type !== 'tool_result') continue;
    const ev = b.tool_use_id ? col.pending.get(b.tool_use_id) : null;
    if (b.tool_use_id) col.pending.delete(b.tool_use_id);
    if (!b.is_error || !ev) continue;
    const c = b.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';
    // 呼び出し側のイベントを失敗に書き換える。新しい行を足さない —
    // 足すと同じ呼び出しが分母に2回出る。
    ev.ok = false;
    ev.text = String(text).replace(/\s+/g, ' ').slice(0, 200);
  }
}

async function collect(T, { baseDir, project, sinceMs, scope } = {}) {
  const col = makeCollector();
  const files = T.locate({ baseDir, project, sinceMs });
  for (const f of files) {
    for await (const e of T.readEntries(f.file)) feed(T, col, e, { sinceMs, scope });
  }
  col.events.sort((a, b) => a.ts - b.ts);
  return col.events;
}

module.exports = { makeCollector, feed, collect };
