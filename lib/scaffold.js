'use strict';

/**
 * scaffold.js — ガード候補から PreToolUse hook の雛形を出す。
 *
 * ループの最後の手作業がここだった: --guardable が「呼ぶ前に止められる」と
 * 判定しても、hook本体は毎回ゼロから書いていた。実際に手で書いた
 * ~/.claude/hooks/pre-tool-mistake-guard.sh を見ると、中身は
 *   1. tool_name が対象か
 *   2. tool_input が既知の悪い形か
 *   3. 悪ければ deny + 理由を返す
 * の3つだけで、変わるのは 2 の条件と文言。そこだけ埋める。
 *
 * **条件は生成しない。** 失敗テキストから「入力のどこが悪いか」を機械的に
 * 導くのは推測になり、間違ったガードは正しいツール呼び出しを止める —
 * 失敗より高くつく。埋めるべき場所に TODO を置いて人に渡す(HITL既定、
 * suggest.js が「対策の判断はLLM/人間の仕事」としているのと同じ線引き)。
 * 生成するのは、毎回書き写している定型と、実測値の埋め込みだけ。
 */

// 失敗テキストから、条件式の手がかりになりそうなフィールド名を拾う。
// あくまで手がかりで、これが条件になるわけではない。
function hintFields(sample) {
  const s = String(sample || '');
  const out = new Set();
  // "tabId must be an integer" / "foo is required" / "Unrecognized key: \"bar\""
  for (const m of s.matchAll(/["`']?([a-zA-Z_][a-zA-Z0-9_.]{1,40})["`']?\s+(?:must be|is required|should be)/g)) out.add(m[1]);
  for (const m of s.matchAll(/Unrecognized key:\s*["`']([^"`']+)["`']/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:property|parameter|field)\s+["`']?([a-zA-Z_][a-zA-Z0-9_.]{1,40})/gi)) out.add(m[1]);
  return [...out];
}

function scaffold(tool, { calls, errors, errorRate, sample, share } = {}) {
  const fields = hintFields(sample);
  const fieldNote = fields.length
    ? `# 失敗テキストが名指ししているフィールド: ${fields.join(', ')}`
    : '# 失敗テキストからフィールド名は拾えなかった。sample を読んで決めること。';
  const checkHint = fields.length
    ? fields.map((f) => `    # ti.get(${JSON.stringify(f.split('.')[0])})`).join('\n')
    : '    # ti.get("...")';
  const pct = share != null ? `${Math.round(share * 100)}%` : '?';

  return `#!/bin/bash
# PreToolUse(${tool}) — 呼ぶ前に既知の失敗パターンを検知して止める。
#
# ccflaky の実測: ${calls}呼出中${errors}失敗(${errorRate}%)、うち${pct}が同一パターン。
#   ${String(sample || '').slice(0, 100)}
#
# 実行時エラーで気づくと1往復(トークン・時間)を無駄にする — 呼ぶ前に
# 検知して同じ往復の中で直させる方が安い。
#
# 入れたら実測すること:
#   ccflaky --watch ${tool}
#   (数日後) ccflaky --verify
# 下がっていなければ診断が外れている。規則を足すのではなく、条件を見直す。

INPUT=$(cat)

python3 - "$INPUT" <<'PY'
import json, sys

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

if d.get("tool_name") != ${JSON.stringify(tool)}:
    sys.exit(0)

ti = d.get("tool_input") or {}

# ---- TODO: ここだけ書く ----------------------------------------------
# 「この呼び出しは失敗する」と呼ぶ前に断言できる条件だけを書く。
# 迷ったら通す — 誤って止める方が、失敗を1回見るより高くつく。
${fieldNote}
${checkHint}
bad = False   # 例: bad = not isinstance(ti.get("tabId"), int)
# ----------------------------------------------------------------------

if not bad:
    sys.exit(0)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            ${JSON.stringify(`${tool}: 既知の失敗パターンに一致します`)}
            ${JSON.stringify(`(実測: ${errorRate}%が失敗、うち${pct}がこの型)。\n`)}
            "TODO: 何をどう直せばよいかを1文で書く。"
        ),
    },
}, ensure_ascii=False))
PY
`;
}

module.exports = { hintFields, scaffold };
