"""
LLMSpaghetti — Reference Classifier
====================================
Implements the three-tier routing pipeline:

  Tier 1: Signal       — attachments, code blocks, token count   ~0ms
  Tier 2: Keyword      — clean trigger words, collision-guarded   ~0ms
  Tier 3: LLM          — genuine ambiguity only                   ~100ms+
  Fallback: general    — when everything else fails

Every classifier (keyword, LLM, hybrid, custom) must implement:
  classify(message: str, ctx: Context) -> Classification

Wire your own into the eval harness:
  from classifier import build_classifier, Context
  def my_llm_fn(message, ctx): ...
  classify = build_classifier(llm_fn=my_llm_fn)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Callable, Optional


# ── Types ─────────────────────────────────────────────────────────────────────

VALID_ROLES = {
    "image", "code", "reasoning", "fast", "document", "general", "none"
}


@dataclass
class Context:
    """Optional context attached to a message."""
    has_file_attachment: bool = False
    has_image:           bool = False
    has_code_blocks:     bool = False
    token_count:         int  = 0                # whole conversation (for budget/logging)
    last_user_tokens:    int  = 0               # just the current user turn (for intent)
    thread_role:         Optional[str] = None   # role of previous message


@dataclass
class Classification:
    """Result returned by every classifier."""
    role:       str                          # one of VALID_ROLES
    tier:       str                          # signal | keyword | override | fixture | llm | fallback
    confidence: float = 1.0                 # 0.0–1.0
    latency_ms: float = 0.0
    reasoning:  Optional[str] = None        # human-readable why


# ── Tier 1: Signal ────────────────────────────────────────────────────────────
# Context signals that override keywords. Order matters — first match wins.

_SIGNAL_RULES: list[tuple[str, Callable[[Context], bool]]] = [
    # File attachment + substantial content → document regardless of keywords
    ("document", lambda ctx: ctx.has_file_attachment and ctx.token_count > 1000),
    # File attachment at all → document (even "quick summary of this file")
    ("document", lambda ctx: ctx.has_file_attachment),
    # Code blocks in context → code regardless of message wording
    ("code",     lambda ctx: ctx.has_code_blocks),
    # Image in context → image (user probably asking about it)
    ("image",    lambda ctx: ctx.has_image),
    # Very long CURRENT message without a file → reasoning (a complex question).
    # Uses last_user_tokens, NOT token_count — otherwise a long *conversation* would
    # trip this and hijack an explicit "draw me a …" / code request after a while.
    ("reasoning",lambda ctx: ctx.last_user_tokens > 2000 and not ctx.has_file_attachment),
]


def _signal_tier(message: str, ctx: Context) -> Optional[Classification]:
    for role, condition in _SIGNAL_RULES:
        if condition(ctx):
            return Classification(
                role=role, tier="signal",
                reasoning=f"context signal → {role}"
            )
    return None


# ── Tier 2: Keyword ───────────────────────────────────────────────────────────
# Patterns ordered by specificity. More specific patterns first.
# Each pattern is (role, regex, negative_lookahead_regex_or_None)

_KEYWORD_RULES: list[tuple[str, re.Pattern, Optional[re.Pattern]]] = [
    # Image — clear generation intent
    ("image", re.compile(
        r'\b(generate\s+(?:an?\s+)?image|draw\s+(?:me\s+)?(?:an?\s+)?|'
        r'create\s+(?:an?\s+)?(?:image|picture|illustration|diagram)|'
        r'make\s+(?:an?\s+)?(?:image|picture|illustration)|'
        r'picture\s+of|image\s+of|illustrat[ei]|'
        r'diagram\s+of|visual[ize]+\s+(?:this|the|a))\b',
        re.IGNORECASE
    ), re.compile(r"\bdon'?t\s+want\s+to\s+(draw|create|generate)\b", re.IGNORECASE)),

    # Code — programming tasks
    ("code", re.compile(
        r'\b('
        # direct action verbs on code artifacts
        r'debug|refactor|implement|'
        r'unit\s+test|sql\s+query|api\s+endpoint|'
        r'fix\s+(?:this\s+)?(?:bug|error|code)|'
        r'explain\s+(?:this\s+)?(?:code|function|class|algorithm)|'
        r'sort\s+(?:a\s+)?(?:list|array)|'
        # "write/create/make/build/generate [me] [a] … <code-noun>" — allow a
        # few adjectives/nouns between the verb and the artifact so natural
        # phrasing ("write a reverse hello world python script") still routes.
        r'(?:write|create|make|build|generate)(?:\s+\w+){0,6}?\s+'
        r'(?:function|class|method|script|program|module|snippet|'
        r'cli|api|endpoint|query|regex)|'
        # a programming language + a code artifact, allowing a few words between
        # ("python reverse script", "javascript sort function")
        r'(?:python|javascript|typescript|java|golang|rust|bash|shell|sql|'
        r'html|css|php|ruby|kotlin|swift)(?:\s+\w+){0,4}?\s+'
        r'(?:script|program|function|code|snippet|class|method|file|app)'
        r')\b',
        re.IGNORECASE
    ), None),

    # Reasoning — deep thinking + open-ended ideation / feedback
    ("reasoning", re.compile(
        r'\b(think\s+through|reason\s+(?:through|about)|'
        r'architect(?:ure)?|design\s+(?:a\s+)?system|'
        r'compare\s+(?:and\s+contrast|the\s+tradeoffs)|'
        r'pros\s+and\s+cons|tradeoffs?\s+between|'
        r'plan\s+(?:how|the|a)\s+(?:migration|system|architecture|'
        r'refactor|rewrite|upgrade|transition|deployment)|'
        r'how\s+(?:would|should|do)\s+(?:i|we|you)\s+(?:migrate|refactor|redesign|restructure)|'
        r'plan\s+how\s+(?:i|we)\s+(?:would|should|could)\s+\w+|'
        r'why\s+does\s+.{0,30}\s+matter|'
        r'help\s+me\s+(?:reason|think|plan|decide|choose|understand\s+why)|'
        # open-ended ideation / feedback / opinion — "here's my idea, thoughts?"
        # "what do you think" is scoped to a substantive object so trivia opinions
        # ("what do you think about pineapple on pizza") stay general.
        r'what\s+do\s+you\s+think\s+(?:of|about)\s+(?:my|this|the|our|your)\s+'
        r'(?:idea|plan|design|approach|architecture|concept|code|project|proposal|'
        r'essay|draft|strategy|solution|feature|model|structure|writing|story)|'
        r'(?:your|any)\s+thoughts|thoughts(?=\s*[?])|'
        r'give\s+me\s+(?:your\s+)?(?:feedback|thoughts|opinion|take)|'
        r'feedback\s+on|critique|poke\s+holes|brainstorm|'
        r'(?:evaluate|assess)\s+(?:my|this|the)\s+\w+|'
        r'i\s+have\s+an\s+idea|'
        r"here'?s\s+(?:an|my)\s+idea|"
        r'is\s+this\s+a\s+good\s+idea|does\s+this\s+(?:idea|plan|approach|design))\b',
        re.IGNORECASE
    ), None),

    # Document — summarisation / analysis (without file attachment, lower confidence)
    ("document", re.compile(
        r'\b(summar(?:y|ies|ise|ize|isation|ization)|'
        r'key\s+(?:points|takeaways)|'
        r'extract\s+(?:all|the)|main\s+(?:points|ideas)|'
        r'what\s+does\s+(?:this|the)\s+(?:document|report|paper|article)\s+say)\b',
        re.IGNORECASE
    ), None),

    # Fast — explicit short/quick signals
    ("fast", re.compile(
        r'^(quick[,\s]|tldr[,:\s]|briefly[,\s]|in\s+one\s+(?:word|sentence)|'
        r'what\s+is\s+(?:a\s+)?[a-z\s]{1,30}\??\s*$|'
        r'who\s+(?:invented|created|discovered|founded)|'
        r'when\s+was\s+|where\s+is\s+)',
        re.IGNORECASE
    ), None),
]


def _keyword_tier(message: str, ctx: Context) -> Optional[Classification]:
    msg = message.strip()
    for role, pattern, negative in _KEYWORD_RULES:
        if pattern.search(msg):
            if negative and negative.search(msg):
                continue  # negative lookahead matched — skip this rule
            return Classification(
                role=role, tier="keyword",
                reasoning=f"keyword match → {role}"
            )
    return None


# ── Tier 3: LLM classifier ───────────────────────────────────────────────────

_LLM_SYSTEM_PROMPT = """You are a routing classifier for an AI gateway called LLMSpaghetti.
Your ONLY job is to read an incoming message and return the single most appropriate role.

Available roles:
  image     - requests to generate, draw, or create images
  code      - writing, debugging, refactoring, or explaining code
  reasoning - complex thinking, planning, architecture, deep "why" questions
  fast      - short simple questions, quick lookups, one-word answers
  document  - summarising, reading, or analysing documents and files
  general   - everything else

Rules:
  - Reply with ONE word only — the role name
  - Never explain your choice
  - Never say anything else
  - If unsure, reply: general

Examples:
  "generate an image of a dog in a cradle" → image
  "why is my Python function returning None?" → code
  "think through the architecture for a REST API" → reasoning
  "what is the capital of Norway?" → fast
  "summarise this document" → document
  "tell me a joke" → general
  "I don't want to draw attention to this issue" → general
  "give me a quick summary of this 40-page contract" → document
"""


def _llm_tier(
    message: str,
    ctx: Context,
    llm_fn: Callable[[str, Context], str]
) -> Classification:
    """Call the LLM classifier. llm_fn must return a single role string."""
    t0 = time.monotonic()
    try:
        raw = llm_fn(message, ctx).strip().lower()
        role = raw if raw in VALID_ROLES else "general"
        latency = (time.monotonic() - t0) * 1000
        return Classification(
            role=role,
            tier="llm",
            confidence=0.85,
            latency_ms=latency,
            reasoning=f"LLM classified as {role} (raw: {raw!r})"
        )
    except Exception as e:
        latency = (time.monotonic() - t0) * 1000
        return Classification(
            role="general",
            tier="fallback",
            confidence=0.3,
            latency_ms=latency,
            reasoning=f"LLM failed ({e!r}) → fallback general"
        )


# ── Public API ────────────────────────────────────────────────────────────────

def classify(message: str, ctx: Optional[Context] = None) -> Classification:
    """
    Reference classifier — keyword only (no LLM tier).
    Fast, deterministic, good enough for the happy path.
    Use build_classifier(llm_fn=...) to enable the LLM tier.
    """
    if ctx is None:
        ctx = Context()

    t0 = time.monotonic()

    result = _signal_tier(message, ctx)
    if result:
        result.latency_ms = (time.monotonic() - t0) * 1000
        return result

    result = _keyword_tier(message, ctx)
    if result:
        result.latency_ms = (time.monotonic() - t0) * 1000
        return result

    # No signal, no keyword → general
    return Classification(
        role="general",
        tier="fallback",
        confidence=0.5,
        latency_ms=(time.monotonic() - t0) * 1000,
        reasoning="no signal or keyword matched → general"
    )


def build_classifier(
    llm_fn: Optional[Callable[[str, Context], str]] = None
) -> Callable[[str, Context], Classification]:
    """
    Build a classifier with an optional LLM tier.

    Usage:
        from classifier import build_classifier, Context

        def my_ollama_call(message, ctx):
            # call Ollama with the classifier Modelfile
            # return ONE role string
            ...

        classify = build_classifier(llm_fn=my_ollama_call)
        result = classify("think through this architecture", Context())
    """
    def _classify(message: str, ctx: Optional[Context] = None) -> Classification:
        if ctx is None:
            ctx = Context()

        t0 = time.monotonic()

        # Tier 1: signals
        result = _signal_tier(message, ctx)
        if result:
            result.latency_ms = (time.monotonic() - t0) * 1000
            return result

        # Tier 2: keywords
        result = _keyword_tier(message, ctx)
        if result:
            result.latency_ms = (time.monotonic() - t0) * 1000
            return result

        # Tier 3: LLM (if available)
        if llm_fn is not None:
            return _llm_tier(message, ctx, llm_fn)

        # Fallback
        return Classification(
            role="general",
            tier="fallback",
            confidence=0.5,
            latency_ms=(time.monotonic() - t0) * 1000,
            reasoning="no signal or keyword matched, no LLM tier → general"
        )

    return _classify


# ── Correction record schema (Flywheel) ──────────────────────────────────────
# Defined here so it's in the same place as the classifier contract.
# Not yet implemented — data model defined now so schema is correct from day one.

CORRECTION_SCHEMA = {
    "predicted_role":   str,       # what the classifier said
    "corrected_role":   str,       # what the user said it should be
    "tier_that_fired":  str,       # which tier made the wrong call
    "context": {
        "has_file_attachment": bool,
        "has_code_blocks":     bool,
        "has_image":           bool,
        "token_count":         int,
        "thread_role":         "str|null",
    },
    "embedding":        list,      # cached from original classification
    "embedding_model":  str,       # PINNED — must match community fixtures
    "message":          "str|null",# full text locally, null in exports
    "source":           str,       # "local" | "community"
    "created_at":       str,       # ISO 8601
    "corroboration":    int,       # how many independent users agreed
    "tombstoned":       bool,      # soft delete — never hard delete
}

# Default embedding model — pin this, changing it breaks soft merge
DEFAULT_EMBEDDING_MODEL = "nomic-embed-text:v1.5"

# Data paths — defined here so everything uses the same paths
OVERRIDES_LOCAL_PATH  = "/opt/llmspaghetti/data/overrides_local.jsonl"
FIXTURES_BASE_PATH    = "/opt/llmspaghetti/data/fixtures_base.jsonl"
CORRECTIONS_EXPORT_PATH = "/opt/llmspaghetti/data/corrections_export.jsonl"
