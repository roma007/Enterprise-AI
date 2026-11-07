#!/bin/sh
# 安装仓库内置 Git hooks（一次性）
set -e
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/commit-msg
echo "已启用 .githooks：pre-commit 校验 HTML 同步，commit-msg 校验节点 ID / 图无影响"
