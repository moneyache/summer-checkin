#!/bin/bash
# changelog-draft.sh: 为「未推送的改动」生成 CHANGELOG 草稿，插入文件顶部
# 用法：./scripts/changelog-draft.sh
# 通常在 pre-push 拦截后运行，生成草稿 → 润色 → git add CHANGELOG.md → commit → push

set -e
zero=$(git rev-parse --show-toplevel)
cl="$zero/CHANGELOG.md"
today=$(date +%Y-%m-%d)
tmp=$(mktemp)

if git rev-parse --verify origin/main >/dev/null 2>&1; then
  range="origin/main..HEAD"
else
  range="HEAD"
fi
commits=$(git rev-list "$range" 2>/dev/null)
[ -z "$commits" ] && { echo "没有未推送的 commit，无需生成草稿"; rm -f "$tmp"; exit 0; }

# 若今日区块已存在，不重复插入，仅提示
if grep -q "^## $today" "$cl"; then
  echo "⚠️  今日($today)区块已存在，未重复插入。待记录的 commit："
  git log --oneline "$range"
  echo "请直接在该区块补充描述后提交。"
  rm -f "$tmp"
  exit 0
fi

{
  echo "## $today · 待补充（草稿，请润色）"
  echo ""
  echo "### 改动"
  git log --oneline "$range" | while read l; do echo "- $l"; done
  files=$(git diff --name-only "$range" | grep -vE "CHANGELOG.md|README.md|agent.md" | sort -u)
  if [ -n "$files" ]; then
    echo ""
    echo "### 涉及文件"
    echo "$files" | while read f; do [ -n "$f" ] && echo "- \`$f\`"; done
  fi
  echo ""
  echo "---"
  echo ""
} > "$tmp"

python3 - "$cl" "$tmp" <<'PY'
import sys
cl, tmp = sys.argv[1], sys.argv[2]
with open(tmp, encoding='utf-8') as f:
    draft = f.read()
with open(cl, encoding='utf-8') as f:
    lines = f.read().split('\n')
idx = next((i for i, l in enumerate(lines) if l.startswith('## ')), len(lines))
out = '\n'.join(lines[:idx]) + ('\n' if lines[:idx] else '') + draft.rstrip('\n') + '\n' + '\n'.join(lines[idx:])
with open(cl, 'w', encoding='utf-8') as f:
    f.write(out)
print("✅ 草稿已插入 CHANGELOG.md 顶部，请润色后提交")
PY

rm -f "$tmp"
