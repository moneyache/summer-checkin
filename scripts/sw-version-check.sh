#!/bin/bash
# sw-version-check.sh: 检查前端文件改动时是否已更新 sw.js 缓存版本
# 用法：./scripts/sw-version-check.sh [--auto-bump]
# 通常由 pre-push hook 调用

set -e
zero=$(git rev-parse --show-toplevel)
sw="$zero/sw.js"

# PWA 缓存清单中的前端资源文件（改动这些必须跟 sw.js 版本号）
WATCH_FILES="index.html styles.css app.js auth.js login.html register.html spaces.html admin.html manifest.json"

# 计算本轮 push 的 commit 范围
if [ $# -ge 1 ] && [ "$1" != "--auto-bump" ]; then
  range="$1"
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
  range="origin/main..HEAD"
else
  range="HEAD"
fi

# 检查是否有被追踪的前端文件改动
changed=""
for f in $WATCH_FILES; do
  if git diff --name-only "$range" 2>/dev/null | grep -qx "$f"; then
    changed="$changed $f"
  fi
done

[ -z "$changed" ] && { echo "✅ 前端资源文件无改动，跳过 SW 版本检查"; exit 0; }

# 检查 sw.js 是否在本轮改动中
if git diff --name-only "$range" 2>/dev/null | grep -qx "sw.js"; then
  echo "✅ sw.js 已在本轮改动中更新"
  exit 0
fi

# --auto-bump 模式：自动升级版本号
if [ "$1" = "--auto-bump" ]; then
  current=$(grep -o "summer-checkin-v[0-9]\+" "$sw" | head -1)
  if [ -z "$current" ]; then
    echo "❌ 无法从 sw.js 中解析当前缓存版本号"
    exit 1
  fi
  ver=$(echo "$current" | grep -o "[0-9]\+$")
  new_ver=$((ver + 1))
  new_cache="summer-checkin-v${new_ver}"
  sed -i '' "s/${current}/${new_cache}/g" "$sw"
  echo "✅ SW 缓存版本自动升级: ${current} → ${new_cache}"
  echo "   请 commit 此变更后再 push"
  exit 1  # 仍然返回非零，让用户 commit 后再 push
fi

# 拦截模式
echo ""
echo "❌ 拦截：前端资源文件有改动，但 sw.js 缓存版本未更新！"
echo "────────────────────────────────────────────"
echo "改动的文件：$changed"
echo "────────────────────────────────────────────"
echo "PWA 用户会因 Service Worker 缓存继续使用旧版本，"
echo "导致功能异常（如今天「超管后台看不到入口」的坑）。"
echo ""
echo "修复方式："
echo "  1. 手动改 sw.js 里的 CACHE 常量版本号"
echo "  2. 或运行: ./scripts/sw-version-check.sh --auto-bump"
echo ""
exit 1
