"""
LLMSpaghetti — context-model classifier adapter (for the eval harness)
======================================================================
Lets you MEASURE the opt-in context model instead of assuming it helps:

    # baseline — keyword only (what CI gates on)
    python3 eval/eval_router.py

    # with the context model on the miss path (needs the model pulled)
    CONTEXT_MODEL=qwen3:0.6b PYTHONPATH=eval python3 eval/eval_router.py \
        --classifier context_classifier:classify

Compare the two misroute rates — that is the honest answer to "does the context
model actually help?", measured on your fixtures rather than assumed.

Mirrors the router's slice-1 behaviour exactly: the model is asked ONLY when the
keyword/signal tiers fall through to `general`, so this measures what the tier
actually changes — not the model classifying everything from scratch.

Env:
  CONTEXT_MODEL   model name (required — no default, so nothing runs by accident)
  CONTEXT_DEVICE  cpu (default) | gpu | auto
  OLLAMA_URL      default http://localhost:11434
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from classifier import Classification, Context
from classifier import classify as keyword_classify

OLLAMA_URL     = os.environ.get("OLLAMA_URL", "http://localhost:11434")
CONTEXT_MODEL  = os.environ.get("CONTEXT_MODEL", "")
CONTEXT_DEVICE = os.environ.get("CONTEXT_DEVICE", "cpu").lower()

# Keep in sync with router/main.py — the roles the model may return.
ROLES = ("image", "code", "reasoning", "fast", "document", "general")

PROMPT = (
    "You are a routing classifier for an LLM gateway. Read the user's message and "
    "choose the single best role to handle it.\n\n"
    "image     — asking for a picture/illustration to be generated\n"
    "code      — writing, debugging, refactoring or explaining code\n"
    "reasoning — planning, architecture, trade-offs, deep analysis\n"
    "document  — summarising or extracting from a long text/document\n"
    "fast      — a short, simple factual question\n"
    "general   — anything else, chit-chat, or genuinely unclear\n\n"
    'Reply with ONLY this JSON: {"role": "<one role from the list>"}\n\n'
    "Message:\n"
)


def _options() -> dict:
    if CONTEXT_DEVICE == "cpu":
        return {"temperature": 0, "num_gpu": 0}
    if CONTEXT_DEVICE == "gpu":
        return {"temperature": 0, "num_gpu": 999}
    return {"temperature": 0}


def _ask(message: str) -> str | None:
    """One classification call. Returns a valid role or None — never raises, so a
    missing model degrades to the keyword result instead of failing the eval."""
    if not CONTEXT_MODEL:
        return None
    body = json.dumps({
        "model":   CONTEXT_MODEL,
        "prompt":  f"/no_think\n{PROMPT}{message[:4000]}",
        "format":  "json",
        "stream":  False,
        "options": _options(),
        "keep_alive": -1,
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate", data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = json.loads(r.read()).get("response") or ""
        role = str((json.loads(raw) or {}).get("role", "")).strip().lower()
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError, OSError):
        return None
    return role if role in ROLES else None


def classify(message: str, ctx: Context | None = None) -> Classification:
    """Keyword/signal first; ask the context model only on a `fallback` — the same
    miss-path placement the router uses, so the numbers reflect reality."""
    result = keyword_classify(message, ctx)
    if result.tier != "fallback":
        return result

    started = time.perf_counter()
    role = _ask(message)
    if not role:
        return result                      # model absent/failed → unchanged
    return Classification(
        role=role,
        tier="context",
        confidence=0.7,                    # single-label: no calibrated score yet
        latency_ms=(time.perf_counter() - started) * 1000,
        reasoning=f"context model ({CONTEXT_MODEL}) → {role}",
    )
