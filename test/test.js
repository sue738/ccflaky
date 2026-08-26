'use strict';
const { makeTracker, feed, summarize, bar } = require('../bin/ccflaky.js');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

const tr = makeTracker();
feed(tr, { type: 'assistant', message: { content: [
  { type: 'tool_use', name: 'Bash', id: 'a1' },
  { type: 'tool_use', name: 'Read', id: 'a2' },
] } });
feed(tr, { type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: 'a1', is_error: true, content: 'command not found: foo' },
  { type: 'tool_result', tool_use_id: 'a2', content: 'file contents' },
] } });
feed(tr, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'a3' }] } });
feed(tr, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a3', content: 'ok' }] } });
feed(tr, { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Ghost', id: 'x' }] } });

const s = summarize(tr);
ok('呼び出し回数を集計', s.total === 3);
ok('ツール別カウント', s.rows.find((r) => r.name === 'Bash').calls === 2);
ok('エラーをidで正しく紐付け', s.rows.find((r) => r.name === 'Bash').errors === 1);
ok('成功したツールはエラー0', s.rows.find((r) => r.name === 'Read').errors === 0);
ok('エラー率を計算', s.rows.find((r) => r.name === 'Bash').errorRate === 50);
ok('全体エラー率', s.errorRate === 33.3);
ok('sidechainは除外', !s.rows.find((r) => r.name === 'Ghost'));
ok('エラー本文を保持', tr.errors[0].text.includes('command not found'));
ok('呼び出し多い順', s.rows[0].name === 'Bash');

const empty = summarize(makeTracker());
ok('空でも落ちない', empty.total === 0 && empty.errorRate === 0);
ok('idが無いtool_useでも数える', (() => {
  const t = makeTracker();
  feed(t, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'NoId' }] } });
  return summarize(t).total === 1;
})());
ok('bar: 長さ一定', bar(1, 2, 10).length === 10 && bar(0, 0, 10).length === 10);

console.log('== 集計範囲の明示 ==');
{
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccflaky-test-'));
  const pdir = path.join(base, '-tmp-proj');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'sess.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'b1' }] } }) + '\n');
  const run = (args, env) => execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'ccflaky.js'), '--base-dir', base].concat(args),
    { encoding: 'utf8', env: Object.assign({}, process.env, env) },
  );

  ok('summarizeがscopeを返す', summarize(makeTracker()).scope === 'main');
  // 出力言語はホストのLANGに依存させない(CI/開発者ごとに違う) — 明示的に
  // CCFLAKY_LANG を指定してどちらの言語でも検証する。
  ok('scope note in the output (en default)', run([], { CCFLAKY_LANG: 'en' }).includes('scope: main loop only'));
  ok('集計範囲を出力に書く(ja)', run([], { CCFLAKY_LANG: 'ja' }).includes('集計範囲: メインループのみ(サブエージェント除く)'));
  ok('--json に scope フィールド', JSON.parse(run(['--json'])).scope === 'main');
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('== --daily: 日をまたぐtool_result ==');
{
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccflaky-daily-test-'));
  const pdir = path.join(base, '-tmp-proj');
  fs.mkdirSync(pdir);
  // 呼び出しは23:59、エラーは翌0:01 — 呼び出しと結果が別の日別トラッカーに
  // 振り分けられる、レビューで見つかった実際の失敗パターン。
  fs.writeFileSync(path.join(pdir, 'sess.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-19T23:59:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x1' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: true, content: 'boom' }] } }),
  ].join('\n') + '\n');
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'ccflaky.js'), '--base-dir', base, '--daily', '--json'],
    { encoding: 'utf8' },
  );
  const daily = JSON.parse(out).daily;
  const day19 = daily.find((d) => d.date === '2026-08-19');
  const day20 = daily.find((d) => d.date === '2026-08-20');
  ok('呼び出し日に1件計上', day19 && day19.total === 1);
  // エラーは結果が届いた日(20日)ではなく呼び出し元の日(19日)に計上する —
  // 元の実装は結果の日に計上しており、call=1,err=0の日とcall=0,err=1の日に
  // 分裂して両方とも errorRate 0% になっていた(レビューで発見・再現)。
  ok('エラーはunknownでなくBashに紐づく', day19 && day19.rows[0].name === 'Bash');
  ok('エラー件数が呼び出し元の日に計上される', day19 && day19.totalErr === 1);
  ok('errorRateが呼び出し元の日で正しく100%になる', day19 && day19.errorRate === 100);
  // 結果しか無い20日は total=0 かつ totalErr=0 になるので、daily配列自体から
  // 消える(main()の `total > 0 || totalErr > 0` フィルタにより) — 0%と誤表示
  // されるより、そもそも出さない方が正しい。
  ok('結果だけの日はcall=0/err=0で出力から消える', !day20);
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('== sinceMs境界: 呼び出しは窓の外・結果は窓の内 ==');
{
  // --days の下限(sinceMs)ちょうどをまたぐ呼び出し。sinceMsより前のentryを
  // feed()に渡す前に間引くと、呼び出しがpendingに登録されないまま結果だけ
  // 来て「呼び出し元不明のunknown・calls=0」に化ける(レビューで発見)。
  const sinceMs = Date.parse('2026-08-20T00:00:00.000Z');
  const trB = makeTracker();
  feed(trB, { type: 'assistant', timestamp: '2026-08-19T23:59:00.000Z',
    message: { content: [{ type: 'tool_use', name: 'Bash', id: 'b1' }] } }, sinceMs);
  feed(trB, { type: 'user', timestamp: '2026-08-20T00:01:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }] } }, sinceMs);
  const sB = summarize(trB);
  ok('窓の外の呼び出しはcallsに数えない', sB.total === 0);
  ok('結果はBashに正しく紐づく(unknownに化けない)', !!sB.rows.find((r) => r.name === 'Bash'));
  ok('エラーは失われず計上される', sB.totalErr === 1);
}

console.log('== --suggest (lib/suggest.js) ==');
{
  const G = require('../lib/suggest.js');
  ok('signatureOf: JSON codeで揃える(IDや数値が違っても同じ型)', (() => {
    const a = G.signatureOf('{"code":"validation_error","request_id":"aaa-111"}');
    const b = G.signatureOf('{"code":"validation_error","request_id":"bbb-222"}');
    return a === b;
  })());
  ok('signatureOf: messageフィールドから型を取る(数値を<n>に畳む)', (() => {
    const a = G.signatureOf('{"message":"row 12 not found"}');
    const b = G.signatureOf('{"message":"row 99 not found"}');
    return a === b && a.includes('<n>');
  })());
  ok('cluster: 同じ型をまとめてcountする', (() => {
    const c = G.cluster([
      { tool: 'X', text: '{"code":"E1"}' },
      { tool: 'X', text: '{"code":"E1"}' },
      { tool: 'X', text: '{"code":"E2"}' },
    ]);
    return c.length === 2 && c[0].count === 2 && c[0].signature === 'E1';
  })());
  ok('suggest: 閾値未満のツールは出さない', (() => {
    const rows = [{ name: 'Rare', calls: 2, errors: 2, errorRate: 100 }];
    return G.suggest(rows, [], { minCalls: 5, minRate: 20 }).length === 0;
  })());
  ok('suggest: calls/errorRateどちらも閾値を満たすツールだけ出す', (() => {
    const rows = [
      { name: 'Flaky', calls: 10, errors: 3, errorRate: 30 },
      { name: 'Common', calls: 100, errors: 5, errorRate: 5 },
    ];
    const errors = [{ tool: 'Flaky', text: '{"code":"E1"}' }];
    const r = G.suggest(rows, errors, { minCalls: 5, minRate: 20 });
    return r.length === 1 && r[0].name === 'Flaky' && r[0].clusters.length === 1;
  })());
}

console.log('== --suggest CLI ==');
{
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccflaky-suggest-'));
  const pdir = path.join(base, '-tmp-proj');
  fs.mkdirSync(pdir);
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'FlakyTool', id: `f${i}` }] } }));
    const isErr = i < 5; // 6件中5件失敗 = 83%
    lines.push(JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `f${i}`, is_error: isErr, content: isErr ? '{"code":"boom"}' : 'ok' },
    ] } }));
  }
  fs.writeFileSync(path.join(pdir, 'sess.jsonl'), lines.join('\n') + '\n');
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccflaky-mem-'));
  fs.writeFileSync(path.join(memDir, 'note.md'), 'FlakyToolについては未知');

  const run = (args) => execFileSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'ccflaky.js'), '--base-dir', base, ...args],
    { encoding: 'utf8' });

  const jsonOut = JSON.parse(run(['--suggest', '--json', '--memory-dir', memDir]));
  ok('--suggest --json: 閾値超えツールを検出', jsonOut.tools.length === 1 && jsonOut.tools[0].name === 'FlakyTool');
  ok('--suggest --json: クラスタリングされている', jsonOut.tools[0].clusters[0].count === 5);
  ok('--suggest --json: memory-dirで記録済みと判定', jsonOut.tools[0].documented === true);

  const jsonNoMem = JSON.parse(run(['--suggest', '--json']));
  ok('--memory-dir無指定ならdocumentedはnull(汎用ツールに個人配置を焼き込まない)', jsonNoMem.tools[0].documented === null);

  const textOut = run(['--suggest']);
  ok('テキスト表示にクラスタと件数を明記', textOut.includes('FlakyTool') && textOut.includes('5x'));

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(memDir, { recursive: true, force: true });
}

// --- guard 候補の判定と再発測定(ccrelapse から統合) ---
const R = require('../lib/relapse.js');
const EV = require('../lib/events.js');
console.log('== classify: 呼ぶ前に防げる型か ==');
ok('tabId must be an integer は input(防げる)',
  R.classify({ sample: 'tabId must be an integer' }).kind === 'input');
ok('input は guardable',
  R.classify({ sample: 'tabId must be an integer' }).guardable === true);
ok('InputValidationError も input',
  R.classify({ sample: '<tool_use_error>InputValidationError: called with input that could not be parsed' }).kind === 'input');
ok('Figma のツール上限は quota(呼ぶ前に直せない)',
  R.classify({ sample: "You've reached the Figma MCP tool call limit for your View seat. Upgrade your plan" }).kind === 'quota');
ok('quota は guardable ではない',
  R.classify({ sample: 'reached the tool call limit — upgrade your plan' }).guardable === false);
ok('session expired は auth',
  R.classify({ sample: 'MCP server "claude.ai Sentry" session expired' }).kind === 'auth');
ok('セレクタ不一致は state',
  R.classify({ sample: 'Error: ".sticky-note textarea" does not match any elements.' }).kind === 'state');
ok('判定できないものは unknown で、guardable にしない',
  R.classify({ sample: 'something went sideways' }).kind === 'unknown'
  && R.classify({ sample: 'something went sideways' }).guardable === false);

console.log('== 判定順: quota/auth を input と誤らない ==');
// 「invalid」を含む quota 文面。順序を間違えると「呼ぶ前に防げる」と誤答する。
ok('invalid を含んでいても quota が優先される',
  R.classify({ sample: 'invalid request: you have reached the rate limit' }).kind === 'quota');
ok('invalid を含んでいても auth が優先される',
  R.classify({ sample: 'invalid token: session expired' }).kind === 'auth');

console.log('== dominance: 原因が1つに寄っているか ==');
const oneCause = [{ signature: 'a', count: 9 }, { signature: 'b', count: 1 }];
const scattered = [{ signature: 'a', count: 6 }, { signature: 'b', count: 4 }, { signature: 'c', count: 4 }];
ok('最頻クラスタと占有率', R.dominance(oneCause).share === 0.9);
ok('失敗ゼロなら top は null', R.dominance([]).top === null);

console.log('== guardCandidate ==');
ok('単一原因 + input なら候補',
  R.guardCandidate({ clusters: [{ signature: 's', count: 10, sample: 'tabId must be an integer' }] }).candidate === true);
ok('原因が散っていれば候補でない(1つ塞いでも残る)',
  R.guardCandidate({ clusters: [
    { signature: 'a', count: 6, sample: 'tabId must be an integer' },
    { signature: 'b', count: 4, sample: 'Unrecognized key: "x"' },
    { signature: 'c', count: 4, sample: 'foo must be a string' },
  ] }).candidate === false);
ok('単一原因でも quota なら候補でない',
  R.guardCandidate({ clusters: [{ signature: 's', count: 40, sample: 'reached the tool call limit' }] }).candidate === false);
ok('候補でない時も理由を返す',
  typeof R.guardCandidate({ clusters: [{ signature: 's', count: 40, sample: 'rate limit' }] }).reason === 'string');

console.log('== ratesAround: 投入前後 ==');
const CUT = 1000;
const ev = [
  { ts: 100, tool: 'X', ok: false, text: 'boom' },
  { ts: 200, tool: 'X', ok: true },
  { ts: 300, tool: 'X', ok: false, text: 'boom' },
  { ts: 400, tool: 'Y', ok: false, text: 'boom' }, // 別ツールは混ぜない
  { ts: 1100, tool: 'X', ok: true },
  { ts: 1200, tool: 'X', ok: true },
];
const r = R.ratesAround(ev, { tool: 'X', cutoffMs: CUT });
ok('前: 3呼出2失敗', r.before.calls === 3 && r.before.errors === 2);
ok('後: 2呼出0失敗', r.after.calls === 2 && r.after.errors === 0);
ok('他ツールを数えない', r.before.calls + r.after.calls === 5);

const sigOf = (t) => String(t || '').slice(0, 4);
const ev2 = [
  { ts: 100, tool: 'X', ok: false, text: 'aaaa-1' },
  { ts: 200, tool: 'X', ok: false, text: 'bbbb-2' },
  { ts: 1100, tool: 'X', ok: false, text: 'bbbb-3' },
];
const r2 = R.ratesAround(ev2, { tool: 'X', cutoffMs: CUT, signature: 'aaaa', signatureOf: sigOf });
ok('signature 指定で、その型の失敗だけを分子にする',
  r2.before.errors === 1 && r2.after.errors === 0);
ok('分母はツール全体のまま(型別の呼出数は割り当てられない)',
  r2.before.calls === 2 && r2.after.calls === 1);

console.log('== verdict: 薄い標本で「効いた」と言わない ==');
ok('投入後が少なければ insufficient(0件でも成功と言わない)',
  R.verdict({ before: { calls: 50, errors: 25, rate: 50 }, after: { calls: 3, errors: 0, rate: 0 } }).verdict === 'insufficient');
ok('十分な標本で0%なら fixed',
  R.verdict({ before: { calls: 50, errors: 25, rate: 50 }, after: { calls: 100, errors: 0, rate: 0 } }).verdict === 'fixed');
ok('半減以上は improved',
  R.verdict({ before: { calls: 50, errors: 25, rate: 50 }, after: { calls: 100, errors: 20, rate: 20 } }).verdict === 'improved');
ok('下がっていなければ worse(診断が外れている可能性を明示)',
  R.verdict({ before: { calls: 50, errors: 10, rate: 20 }, after: { calls: 100, errors: 30, rate: 30 } }).verdict === 'worse');
ok('投入前が無ければ no-baseline',
  R.verdict({ before: { calls: 0, errors: 0, rate: null }, after: { calls: 100, errors: 0, rate: 0 } }).verdict === 'no-baseline');

console.log('== 実測の再現: ScheduleWakeup ==');
// incident: 投入前6日 25/84 = 29.8%、投入後3日 1/176 = 0.6%
const real = R.verdict({ before: { calls: 84, errors: 25, rate: 29.76 }, after: { calls: 176, errors: 1, rate: 0.57 } });
ok('実測値で improved 以上と判定される', real.verdict === 'improved' || real.verdict === 'fixed');
ok('呼出が増えていることが数字に残る(使わなくなった訳ではない)', 176 > 84);

console.log('== events: 呼び出しと結果の対応付け ==');
// transcript.js の最小スタブ(この層の分岐だけ検証する)
const T = {
  isMainLoop: () => true,
  isAssistant: (e) => e.type === 'assistant',
  isUser: (e) => e.type === 'user',
  toolUsesOf: (e) => e.uses || [],
  blocksOf: (e) => e.blocks || [],
};
{
  const col = EV.makeCollector();
  EV.feed(T, col, { type: 'assistant', timestamp: '2026-08-01T00:00:00Z', uses: [{ id: 'u1', name: 'X' }] });
  EV.feed(T, col, { type: 'user', timestamp: '2026-08-01T00:00:01Z',
    blocks: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'tabId must be an integer' }] });
  ok('失敗は行を増やさず呼び出し側を書き換える(分母が二重にならない)', col.events.length === 1);
  ok('失敗として記録される', col.events[0].ok === false);
  ok('時刻は呼び出し側のもの', col.events[0].ts === Date.parse('2026-08-01T00:00:00Z'));
}
{
  const col = EV.makeCollector();
  EV.feed(T, col, { type: 'assistant', timestamp: '2026-08-01T00:00:00Z', uses: [{ id: 'u2', name: 'X' }] });
  ok('結果が返らなかった呼び出しも分母に入る', col.events.length === 1 && col.events[0].ok === true);
}
{
  // 呼び出しが窓の外・結果が窓の内。pending に入っていないと unknown 化する。
  const cut = Date.parse('2026-08-10T00:00:00Z');
  const col = EV.makeCollector();
  EV.feed(T, col, { type: 'assistant', timestamp: '2026-08-01T00:00:00Z', uses: [{ id: 'u3', name: 'X' }] }, { sinceMs: cut });
  EV.feed(T, col, { type: 'user', timestamp: '2026-08-11T00:00:00Z',
    blocks: [{ type: 'tool_result', tool_use_id: 'u3', is_error: true, content: 'boom' }] }, { sinceMs: cut });
  ok('窓外の呼び出しは計上しないが、対応付けは失わない', col.events.length === 0);
}


console.log('== scaffold: 条件は生成せず、埋める場所を1つに絞る ==');
const SC = require('../lib/scaffold.js');
ok('"X must be an integer" から X を拾う',
  SC.hintFields('tabId must be an integer').includes('tabId'));
ok('"Unrecognized key: \"x\"" から x を拾う',
  SC.hintFields('Unrecognized key: "pages.0.foo"').includes('pages.0.foo'));
ok('手がかりが無くても落ちない', Array.isArray(SC.hintFields('boom')));
{
  const out = SC.scaffold('T', { calls: 10, errors: 2, errorRate: 20, sample: 'tabId must be an integer', share: 1 });
  ok('対象ツール名で早期 return する', out.includes('!= "T"'));
  ok('実測値が本文に入る', out.includes('10呼出中2失敗(20%)'));
  ok('条件は書かず bad = False のまま渡す', out.includes('bad = False'));
  ok('拾ったフィールド名を手がかりとして出す', out.includes('tabId'));
  ok('投入後に測る手順を書き込む', out.includes('--watch T') && out.includes('--verify'));
  ok('deny を返す形になっている', out.includes('"permissionDecision": "deny"'));
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
