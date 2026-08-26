'use strict';
const { makeTracker, feed, summarize, bar } = require('../bin/cctoolstats.js');
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctoolstats-test-'));
  const pdir = path.join(base, '-tmp-proj');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'sess.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'b1' }] } }) + '\n');
  const run = (args, env) => execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'cctoolstats.js'), '--base-dir', base].concat(args),
    { encoding: 'utf8', env: Object.assign({}, process.env, env) },
  );

  ok('summarizeがscopeを返す', summarize(makeTracker()).scope === 'main');
  // 出力言語はホストのLANGに依存させない(CI/開発者ごとに違う) — 明示的に
  // CCTOOLSTATS_LANG を指定してどちらの言語でも検証する。
  ok('scope note in the output (en default)', run([], { CCTOOLSTATS_LANG: 'en' }).includes('scope: main loop only'));
  ok('集計範囲を出力に書く(ja)', run([], { CCTOOLSTATS_LANG: 'ja' }).includes('集計範囲: メインループのみ(サブエージェント除く)'));
  ok('--json に scope フィールド', JSON.parse(run(['--json'])).scope === 'main');
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('== --daily: 日をまたぐtool_result ==');
{
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctoolstats-daily-test-'));
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
    [path.join(__dirname, '..', 'bin', 'cctoolstats.js'), '--base-dir', base, '--daily', '--json'],
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctoolstats-suggest-'));
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
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctoolstats-mem-'));
  fs.writeFileSync(path.join(memDir, 'note.md'), 'FlakyToolについては未知');

  const run = (args) => execFileSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'cctoolstats.js'), '--base-dir', base, ...args],
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

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
