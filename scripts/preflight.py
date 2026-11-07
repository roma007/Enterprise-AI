#!/usr/bin/env python3
"""提交前预检：把《实施全景图.md》/《内部开发与发布.md》的铁律变成可执行检查。

检查内容：
1. 改了 `实施全景图.md`，必须同时提交重新生成的 `实施全景图.html`。
2. 改了代码/脚本/CI/运维配置，提交说明必须带节点 ID（如 `[AI-21]`、`[DEP-14]`），
   或显式声明 `图无影响：<原因>`；带节点 ID 时还必须同提交更新两份事实源之一。
3. 文档类改动不强制节点 ID。

用法：
    python3 scripts/preflight.py --staged                  # pre-commit
    python3 scripts/preflight.py --message-file .git/COMMIT_EDITMSG  # commit-msg
    python3 scripts/preflight.py --commit HEAD             # CI / 事后核查
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MD_NAME = "实施全景图.md"
DEV_MD_NAME = "内部开发与发布.md"
HTML_NAME = "实施全景图.html"
DOC_NAMES = (MD_NAME, DEV_MD_NAME)

CODE_PREFIXES = (
    "backend/",
    "frontend/",
    "ai-copilot/",
    "scripts/",
    "ops/",
    ".github/",
)
CODE_FILES = {"Makefile", "docker-compose.yml", "Dockerfile"}

NODE_ID = re.compile(r"\[[A-Z]{2,4}-\d{2,3}\]")
NO_IMPACT = re.compile(r"图无影响\s*[：:]")


def run(args: list[str]) -> str:
    return subprocess.run(
        args, cwd=ROOT, check=True, text=True, capture_output=True
    ).stdout


def git(*args: str) -> str:
    # 关闭路径转义，否则中文文件名会变成 "\345\256..."，无法匹配。
    return run(["git", "-c", "core.quotePath=false", *args])


def changed_files(args: list[str]) -> list[str]:
    return [line for line in git(*args).splitlines() if line.strip()]


def is_code(path: str) -> bool:
    if path in CODE_FILES:
        return True
    return path.startswith(CODE_PREFIXES) and not path.endswith(".md")


def html_is_fresh() -> tuple[bool, str]:
    """重新生成 HTML，与工作区内容比较；比较后恢复原文件，避免副作用。"""
    html_path = ROOT / HTML_NAME
    original = html_path.read_bytes() if html_path.exists() else b""
    try:
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_impl_map.py")],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        )
        generated = html_path.read_bytes()
    finally:
        if original:
            html_path.write_bytes(original)
    if generated != original:
        return False, f"{HTML_NAME} 未重新生成或仍有手改；请运行 make impl-map 并一起提交"
    return True, ""


def check(files: list[str], message: str, label: str) -> list[str]:
    errors: list[str] = []
    code_files = [f for f in files if is_code(f)]
    main_changed = MD_NAME in files
    doc_changed = any(name in files for name in DOC_NAMES)
    html_changed = HTML_NAME in files

    if main_changed:
        fresh, why = html_is_fresh()
        if not fresh:
            errors.append(why)
        elif not html_changed:
            errors.append(f"改了 {MD_NAME} 但没有一起提交 {HTML_NAME}")

    if code_files:
        has_node = bool(NODE_ID.search(message))
        no_impact = bool(NO_IMPACT.search(message))
        # pre-commit 阶段还没有提交说明；消息检查交给 commit-msg / CI。
        if message.strip() and not has_node and not no_impact:
            errors.append(
                "改了代码但没有节点 ID 或“图无影响：<原因>”："
                "提交说明请带 [AI-21]/[MT-05]/[CI-12]/[DEP-14] 这类节点 ID，"
                "或写“图无影响：<原因>”"
            )
        elif has_node and not doc_changed and not no_impact:
            errors.append(
                "提交说明带了节点 ID，但没有同提交更新 "
                f"{MD_NAME} 或 {DEV_MD_NAME}；请更新对应文档与“最近核验”"
            )

    if errors:
        print(f"preflight 失败（{label}）：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print(f"  涉及文件：{', '.join(files)}", file=sys.stderr)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--staged", action="store_true", help="检查暂存区")
    parser.add_argument("--commit", metavar="REV", help="检查某个提交，如 HEAD")
    parser.add_argument("--message-file", help="提交说明文件（commit-msg hook）")
    parser.add_argument("--message-only", action="store_true", help="只检查提交说明")
    args = parser.parse_args()

    if args.commit:
        parents = git("rev-list", "--parents", "-n", "1", args.commit).split()
        if len(parents) > 2:
            print("preflight 跳过：合并提交不检查")
            return 0
        files = changed_files(
            ["show", "--pretty=format:", "--name-only", args.commit]
        )
        message = git("log", "-1", "--pretty=%B", args.commit)
        label = args.commit
    else:
        files = changed_files(["diff", "--cached", "--name-only"])
        message = ""
        if args.message_file:
            message = Path(args.message_file).read_text(encoding="utf-8")
        label = "暂存区"

    if not files and not args.message_only:
        print("preflight 通过：没有暂存改动")
        return 0

    if args.message_only:
        if not message.strip():
            print("preflight 失败：提交说明为空", file=sys.stderr)
            return 1
        code_files = [f for f in files if is_code(f)]
        has_node = bool(NODE_ID.search(message))
        no_impact = bool(NO_IMPACT.search(message))
        if code_files and not has_node and not no_impact:
            print(
                "preflight 失败：代码改动缺少节点 ID 或“图无影响：<原因>”",
                file=sys.stderr,
            )
            return 1
        if code_files and has_node and MD_NAME not in files and DEV_MD_NAME not in files and not no_impact:
            print(
                f"preflight 失败：带节点 ID 但没有同提交更新 {MD_NAME} 或 {DEV_MD_NAME}",
                file=sys.stderr,
            )
            return 1
        print("preflight 通过：提交说明符合要求")
        return 0

    errors = check(files, message, label)
    if errors:
        return 1
    print(f"preflight 通过：{len(files)} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
