#!/usr/bin/env python3
"""
collect_code_context.py

Recursively collect useful source/config files from a project into one
GPT-friendly text file.

Designed for TypeScript / React / Node / Fastify / CosmJS / Prisma projects.

Examples:
    python collect_code_context.py
    python collect_code_context.py . -o project_context.txt
    python collect_code_context.py /path/to/project -o context.md
    python collect_code_context.py . --max-file-kb 300

Notes:
- Dependency/build/cache folders are skipped.
- Lock files and obvious generated/minified files are skipped.
- .env files are included with VALUES REDACTED by default.
- Binary files are ignored.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Iterable


# Folders that are normally irrelevant/noisy for GPT code context.
EXCLUDED_DIRS = {
    # Version control / IDE
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",

    # Python
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",

    # Node / JS / TS
    "node_modules",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".turbo",
    ".next",
    ".nuxt",
    ".vite",

    # Builds / coverage / caches
    "dist",
    "build",
    "out",
    "coverage",
    ".coverage",
    ".cache",
    "cache",
    "tmp",
    "temp",

    # Misc generated/runtime
    "logs",
    "log",
}

# Extensions worth including for the described stack.
INCLUDED_EXTENSIONS = {
    # TypeScript / JavaScript / React
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",

    # Frontend styles/templates
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".html",

    # DB / schema
    ".sql",
    ".prisma",

    # Config/data
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",

    # Shell / scripts
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",

    # Documentation useful for architecture/context
    ".md",
    ".mdx",
    ".txt",

    # Other commonly useful project files
    ".graphql",
    ".gql",
    ".proto",
}

# Extensionless/special files worth including.
INCLUDED_FILENAMES = {
    "Dockerfile",
    "dockerfile",
    "Makefile",
    "Procfile",
    ".dockerignore",
    ".gitignore",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
    "tsconfig",
}

# Files that are often huge/noisy and generally don't help GPT understand code.
EXCLUDED_FILENAMES = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
    ".DS_Store",
}

# Generated/minified patterns.
EXCLUDED_PATTERNS = [
    re.compile(r"\.min\.(js|css)$", re.IGNORECASE),
    re.compile(r"\.map$", re.IGNORECASE),
    re.compile(r"\.generated\.", re.IGNORECASE),
    re.compile(r"\.bundle\.", re.IGNORECASE),
]

ENV_NAME_RE = re.compile(r"^\.env(?:\..+)?$", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect project source files into a single GPT-friendly context file."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="Project root directory (default: current directory).",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="project_context.txt",
        help="Output file path (default: project_context.txt).",
    )
    parser.add_argument(
        "--max-file-kb",
        type=int,
        default=500,
        help="Skip individual files larger than this size in KB (default: 500).",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Include hidden files/folders unless explicitly excluded.",
    )
    parser.add_argument(
        "--no-env",
        action="store_true",
        help="Completely skip .env* files instead of including redacted keys.",
    )
    return parser.parse_args()


def is_hidden(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        rel = path
    return any(part.startswith(".") for part in rel.parts)


def is_excluded_dir(path: Path) -> bool:
    return path.name in EXCLUDED_DIRS


def is_excluded_file(path: Path) -> bool:
    if path.name in EXCLUDED_FILENAMES:
        return True
    return any(pattern.search(path.name) for pattern in EXCLUDED_PATTERNS)


def is_env_file(path: Path) -> bool:
    return bool(ENV_NAME_RE.match(path.name))


def should_include_file(
    path: Path,
    root: Path,
    include_hidden: bool,
    no_env: bool,
) -> bool:
    if is_excluded_file(path):
        return False

    if is_env_file(path):
        return not no_env

    if not include_hidden and is_hidden(path, root):
        # Keep useful hidden config files that were explicitly allowlisted.
        if path.name not in INCLUDED_FILENAMES:
            return False

    if path.name in INCLUDED_FILENAMES:
        return True

    return path.suffix.lower() in INCLUDED_EXTENSIONS


def looks_binary(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            chunk = f.read(4096)
        return b"\x00" in chunk
    except OSError:
        return True


def redact_env(content: str) -> str:
    """
    Preserve comments, blank lines, and variable names, but redact values.

    Example:
        RPC_URL=https://secret.example
    becomes:
        RPC_URL=<REDACTED>
    """
    output = []

    for line in content.splitlines():
        stripped = line.strip()

        if not stripped or stripped.startswith("#"):
            output.append(line)
            continue

        # Handles:
        # KEY=value
        # export KEY=value
        match = re.match(
            r"^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$",
            line,
        )
        if match:
            output.append(f"{match.group(1)}<REDACTED>")
        else:
            # Keep unusual/non-assignment lines visible, but don't risk copying them raw.
            output.append("# <UNRECOGNIZED ENV LINE REDACTED>")

    return "\n".join(output)


def language_hint(path: Path) -> str:
    suffix_map = {
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".jsx": "jsx",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".css": "css",
        ".scss": "scss",
        ".sass": "sass",
        ".less": "less",
        ".html": "html",
        ".sql": "sql",
        ".prisma": "prisma",
        ".json": "json",
        ".jsonc": "jsonc",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".toml": "toml",
        ".sh": "bash",
        ".bash": "bash",
        ".zsh": "bash",
        ".ps1": "powershell",
        ".md": "markdown",
        ".mdx": "mdx",
        ".graphql": "graphql",
        ".gql": "graphql",
        ".proto": "protobuf",
    }

    if is_env_file(path):
        return "dotenv"
    if path.name.lower() == "dockerfile":
        return "dockerfile"
    if path.name == "Makefile":
        return "makefile"

    return suffix_map.get(path.suffix.lower(), "text")


def iter_files(
    root: Path,
    output_path: Path,
    include_hidden: bool,
    no_env: bool,
) -> Iterable[Path]:
    """
    Walk manually so excluded directories are pruned before recursion.
    """
    for current_dir, dirnames, filenames in os.walk(root):
        current = Path(current_dir)

        # Prune excluded dirs in-place.
        kept_dirs = []
        for dirname in dirnames:
            d = current / dirname

            if is_excluded_dir(d):
                continue

            if not include_hidden and dirname.startswith("."):
                continue

            kept_dirs.append(dirname)

        dirnames[:] = kept_dirs

        for filename in filenames:
            path = current / filename

            try:
                if path.resolve() == output_path.resolve():
                    continue
            except OSError:
                pass

            if should_include_file(path, root, include_hidden, no_env):
                yield path


def read_text_file(path: Path) -> str | None:
    # UTF-8 first, then a forgiving fallback for normal source files.
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
    except OSError:
        return None


def main() -> None:
    args = parse_args()

    root = Path(args.root).expanduser().resolve()
    output_path = Path(args.output).expanduser()
    if not output_path.is_absolute():
        output_path = (Path.cwd() / output_path).resolve()

    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Error: root directory does not exist: {root}")

    max_bytes = args.max_file_kb * 1024

    files = sorted(
        iter_files(
            root=root,
            output_path=output_path,
            include_hidden=args.include_hidden,
            no_env=args.no_env,
        ),
        key=lambda p: str(p.relative_to(root)).lower(),
    )

    included_count = 0
    skipped_large = []
    skipped_binary = []
    skipped_unreadable = []

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as out:
        out.write("# PROJECT CODE CONTEXT\n\n")
        out.write(f"Root: {root}\n")
        out.write(
            "Generated by collect_code_context.py. "
            ".env values are redacted unless .env files are disabled.\n\n"
        )

        # Add a compact file tree first so GPT can understand structure.
        out.write("=" * 100 + "\n")
        out.write("PROJECT FILE TREE (included candidates)\n")
        out.write("=" * 100 + "\n\n")

        for path in files:
            rel = path.relative_to(root)
            out.write(f"- {rel.as_posix()}\n")

        out.write("\n\n")

        for path in files:
            rel = path.relative_to(root)

            try:
                size = path.stat().st_size
            except OSError:
                skipped_unreadable.append(rel.as_posix())
                continue

            if size > max_bytes:
                skipped_large.append((rel.as_posix(), size))
                continue

            if looks_binary(path):
                skipped_binary.append(rel.as_posix())
                continue

            content = read_text_file(path)
            if content is None:
                skipped_unreadable.append(rel.as_posix())
                continue

            if is_env_file(path):
                content = redact_env(content)

            lang = language_hint(path)

            out.write("=" * 100 + "\n")
            out.write(f"FILE: {rel.as_posix()}\n")
            out.write("=" * 100 + "\n")
            out.write(f"```{lang}\n")
            out.write(content)

            if content and not content.endswith("\n"):
                out.write("\n")

            out.write("```\n\n")
            included_count += 1

        out.write("\n" + "=" * 100 + "\n")
        out.write("COLLECTION SUMMARY\n")
        out.write("=" * 100 + "\n")
        out.write(f"Included files: {included_count}\n")

        if skipped_large:
            out.write("\nSkipped because they exceeded the file-size limit:\n")
            for name, size in skipped_large:
                out.write(f"- {name} ({size / 1024:.1f} KB)\n")

        if skipped_binary:
            out.write("\nSkipped binary-looking files:\n")
            for name in skipped_binary:
                out.write(f"- {name}\n")

        if skipped_unreadable:
            out.write("\nSkipped unreadable files:\n")
            for name in skipped_unreadable:
                out.write(f"- {name}\n")

    print(f"Done. Included {included_count} files.")
    print(f"Output: {output_path}")
    print("Tip: upload the output file to ChatGPT as project/code context.")


if __name__ == "__main__":
    main()
