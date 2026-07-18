#!/usr/bin/env python3
"""
LLMSpaghetti — config migration
===============================
Adds config keys that a new release introduced to an ALREADY-INSTALLED config,
without ever touching values the user has set.

`spag update` deliberately does NOT copy config/*.yaml over the installed ones —
that would clobber role assignments, API keys and render settings. The side effect
is that a NEW setting added in a release never reaches an existing box: the code
supports it, the config doesn't mention it, and the user has to hand-append it.
(That happened with `context_model` — smart routing shipped and nobody could turn
it on without editing YAML by hand.)

This closes that gap with the only safe merge direction:

    add top-level keys that exist in the template and are MISSING locally
    never modify, reorder or remove anything already there

Line-based on purpose — a YAML round-trip would strip every comment, and in these
files the comments ARE the documentation. Each added key brings its explanatory
comment block with it.

Usage:  config-migrate.py <template-dir> <installed-dir> [--dry-run]
Exit:   0 always (a migration failure must never break an update)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TOP_LEVEL = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:")


def top_level_keys(text: str) -> set[str]:
    return {m.group(1) for line in text.splitlines() if (m := TOP_LEVEL.match(line))}


def blocks(text: str) -> list[tuple[str, list[str]]]:
    """Template → [(key, lines)], each key carrying its preceding comment block and
    any indented children, so an added setting arrives documented."""
    lines = text.splitlines()
    out: list[tuple[str, list[str]]] = []
    pending: list[str] = []          # comments/blanks not yet attached to a key

    i = 0
    while i < len(lines):
        line = lines[i]
        m = TOP_LEVEL.match(line)
        if not m:
            pending.append(line)
            i += 1
            continue

        # Comments directly above the key belong to it; a blank line ends the run.
        lead: list[str] = []
        while pending and pending[-1].lstrip().startswith("#"):
            lead.insert(0, pending.pop())

        body = [*lead, line]
        i += 1
        while i < len(lines) and (not lines[i].strip() or lines[i][:1].isspace()):
            body.append(lines[i])
            i += 1
        while body and not body[-1].strip():      # trim trailing blanks
            body.pop()

        out.append((m.group(1), body))
        pending = []
    return out


def migrate(template: Path, installed: Path, dry_run: bool = False) -> list[str]:
    tpl = template.read_text()
    cur = installed.read_text()
    have = top_level_keys(cur)

    added: list[str] = []
    additions: list[str] = []
    for key, body in blocks(tpl):
        if key in have:
            continue                              # present → never touch it
        additions.append("\n".join(body))
        added.append(key)

    if added and not dry_run:
        text = cur.rstrip("\n") + "\n\n" + "\n\n".join(additions) + "\n"
        installed.write_text(text)
    return added


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if len(args) != 2:
        print(__doc__)
        return 0

    tpl_dir, inst_dir = Path(args[0]), Path(args[1])
    if not tpl_dir.is_dir() or not inst_dir.is_dir():
        return 0

    total = 0
    for tpl in sorted(tpl_dir.glob("*.yaml")):
        inst = inst_dir / tpl.name
        if not inst.is_file():
            continue                              # not installed → not ours to create
        try:
            added = migrate(tpl, inst, dry)
        except OSError as e:
            print(f"  ! {tpl.name}: {e}")
            continue
        if added:
            total += len(added)
            verb = "would add" if dry else "added"
            print(f"  {tpl.name}: {verb} {', '.join(added)}")

    if total:
        print(f"config migration: {total} new setting(s) — your existing values were not touched")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                        # never break an update
        print(f"config migration skipped ({e!r})")
        sys.exit(0)
