#!/usr/bin/env python3
"""
LLMSpaghetti — Phase 1 end-to-end routing test.

Tests the 5 scenarios from TODO.md using the classifier directly.
Run with:  python3 test/test_phase1.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "eval"))
from classifier import classify, Context

GREEN = "\033[32m"; RED = "\033[31m"; BOLD = "\033[1m"; RESET = "\033[0m"

passed = 0
failed = 0


def check(label: str, message: str, expected_role: str, ctx: Context = None):
    global passed, failed
    result = classify(message, ctx or Context())
    ok = result.role == expected_role
    if ok:
        passed += 1
        print(f"  {GREEN}✓{RESET}  {label}")
        print(f"       tier={result.tier}  role={result.role}  ({result.latency_ms:.1f}ms)")
    else:
        failed += 1
        print(f"  {RED}✗{RESET}  {label}")
        print(f"       expected={expected_role}  got={result.role}  tier={result.tier}")
        if result.reasoning:
            print(f"       reason: {result.reasoning}")


print(f"\n{BOLD}Phase 1 — End-to-End Routing Scenarios{RESET}\n")

# ── TODO.md test scenarios ────────────────────────────────────────────────────

print(f"{BOLD}TODO.md scenarios:{RESET}")

check(
    '"I need a picture of a dog in a cradle" → image',
    "I need a picture of a dog in a cradle",
    "image",
)

check(
    '"Think through this architecture" → reasoning',
    "Think through this architecture for a distributed system",
    "reasoning",
)

check(
    '"Quick, what is the capital of Norway?" → fast',
    "Quick, what is the capital of Norway?",
    "fast",
)

check(
    '"Here is my confidential document..." → document (file attachment)',
    "Here is my confidential document, please summarise it",
    "document",
    Context(has_file_attachment=True, token_count=500),
)

check(
    '"Debug this Python function" → code',
    "Debug this Python function — it keeps returning None",
    "code",
)

# ── Additional edge cases ─────────────────────────────────────────────────────

print(f"\n{BOLD}Edge cases:{RESET}")

check(
    'Code block in context overrides keywords → code',
    "What does this do?",
    "code",
    Context(has_code_blocks=True),
)

check(
    'Long message without file → reasoning',
    "Explain the tradeoffs between event sourcing and traditional CRUD",
    "reasoning",
    Context(token_count=2100),
)

check(
    '"I don\'t want to draw attention to this" → NOT image (negative match)',
    "I don't want to draw attention to this issue in the meeting",
    "general",
)

check(
    '"tldr what is docker" → fast',
    "tldr what is docker",
    "fast",
)

check(
    'File + quick → document, not fast (CRITICAL guard)',
    "give me a quick summary of this 40-page contract",
    "document",
    Context(has_file_attachment=True, token_count=9000),
)

check(
    '"generate an image of a robot chef eating spaghetti" → image',
    "generate an image of a robot chef eating spaghetti",
    "image",
)

check(
    '"refactor this function" → code',
    "refactor this function to be more readable",
    "code",
)

# ── Summary ───────────────────────────────────────────────────────────────────

total = passed + failed
print(f"\n{'─' * 50}")
print(f"  {passed}/{total} passed", end="")
if failed:
    print(f"  {RED}{failed} FAILED{RESET}")
else:
    print(f"  {GREEN}all good{RESET}")
print()

sys.exit(0 if failed == 0 else 1)
