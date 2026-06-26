"""
LLMSpaghetti — Router Eval Harness
====================================
Runs fixtures against a classifier, prints metrics, exits non-zero
when a budget is breached. Works as a CI gate.

Usage:
  python3 eval_router.py                                    # reference classifier
  python3 eval_router.py --classifier mymodule:classify    # yours
  python3 eval_router.py --max-misroute 0.08 --max-critical 0 --max-p95-ms 600
  python3 eval_router.py --fixtures ../community/fixtures/contributed/

Exit codes:
  0 = all budgets met
  1 = budget breached
  2 = fixture or import error
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Callable

# Force UTF-8 output so the emoji banner/check marks render on any host
# console (Windows cp1252 otherwise crashes with UnicodeEncodeError).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

# Add eval/ to path so we can import classifier
sys.path.insert(0, str(Path(__file__).parent))
from classifier import classify as reference_classify, Context, Classification, VALID_ROLES


# ── Critical misroute definition ──────────────────────────────────────────────
# These are the dangerous routing mistakes — budget defaults to 0.
def is_critical(predicted: str, expected: str) -> bool:
    """
    Critical misroutes are routing mistakes that cost money or lose work:
      - Anything wrongly sent to image  (costs DALL-E API money)
      - Anything wrongly dropped to none (message disappears)
      - Serious task downgraded to fast (shallow answer to deep question)
    """
    if predicted == "image" and expected != "image":
        return True   # surprise DALL-E call = money
    if predicted == "none":
        return True   # message disappears
    if predicted == "fast" and expected in ("document", "reasoning", "code"):
        return True   # serious task gets shallow answer
    return False


# ── Load fixtures ─────────────────────────────────────────────────────────────

def load_fixtures(paths: list[Path]) -> list[dict]:
    fixtures = []
    for path in paths:
        if path.is_dir():
            for f in sorted(path.glob("*.jsonl")):
                fixtures.extend(_load_jsonl(f))
        elif path.exists():
            fixtures.extend(_load_jsonl(path))
        else:
            print(f"[WARN] fixture path not found: {path}", file=sys.stderr)
    return fixtures


def _load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"[ERR] {path}:{i} — {e}", file=sys.stderr)
                sys.exit(2)
    return rows


# ── Load custom classifier ────────────────────────────────────────────────────

def load_classifier(spec: str) -> Callable:
    """Load a classifier from 'module:function' spec."""
    try:
        module_name, fn_name = spec.rsplit(":", 1)
        module = importlib.import_module(module_name)
        fn = getattr(module, fn_name)
        return fn
    except Exception as e:
        print(f"[ERR] Cannot load classifier {spec!r}: {e}", file=sys.stderr)
        sys.exit(2)


# ── Run eval ──────────────────────────────────────────────────────────────────

def run_eval(
    fixtures: list[dict],
    classifier_fn: Callable,
    verbose: bool = False,
) -> dict:
    results = []
    latencies = []
    confusion = defaultdict(lambda: defaultdict(int))   # confusion[expected][predicted]

    for fix in fixtures:
        msg      = fix.get("message", "")
        expected = fix.get("expected", "general")
        ctx_raw  = fix.get("context", {})
        note     = fix.get("note", "")
        fid      = fix.get("id", "?")

        ctx = Context(
            has_file_attachment = ctx_raw.get("has_file_attachment", False),
            has_image           = ctx_raw.get("has_image", False),
            has_code_blocks     = ctx_raw.get("has_code_blocks", False),
            token_count         = ctx_raw.get("token_count", 0),
            thread_role         = ctx_raw.get("thread_role", None),
        )

        t0 = time.monotonic()
        try:
            result = classifier_fn(msg, ctx)
            if isinstance(result, Classification):
                predicted  = result.role
                tier       = result.tier
                elapsed_ms = result.latency_ms or (time.monotonic() - t0) * 1000
            else:
                predicted  = str(result).strip().lower()
                tier       = "unknown"
                elapsed_ms = (time.monotonic() - t0) * 1000
        except Exception as e:
            predicted  = "general"
            tier       = "error"
            elapsed_ms = (time.monotonic() - t0) * 1000
            if verbose:
                print(f"  [ERR] {fid}: {e}")

        correct  = predicted == expected
        critical = is_critical(predicted, expected)
        latencies.append(elapsed_ms)
        confusion[expected][predicted] += 1

        results.append({
            "id":        fid,
            "message":   msg,
            "expected":  expected,
            "predicted": predicted,
            "tier":      tier,
            "correct":   correct,
            "critical":  critical,
            "latency_ms": elapsed_ms,
            "note":      note,
        })

        if verbose and not correct:
            crit_marker = " ⚠ CRITICAL" if critical else ""
            print(f"  MISS {fid}{crit_marker}")
            print(f"       expected={expected} got={predicted} tier={tier}")
            if note:
                print(f"       note: {note}")

    total       = len(results)
    misroutes   = sum(1 for r in results if not r["correct"])
    criticals   = sum(1 for r in results if r["critical"])
    escalations = sum(1 for r in results if r.get("tier") == "llm")

    latencies_sorted = sorted(latencies)
    p50 = latencies_sorted[int(total * 0.50)] if total else 0
    p95 = latencies_sorted[int(total * 0.95)] if total else 0

    return {
        "total":            total,
        "misroutes":        misroutes,
        "misroute_rate":    misroutes / total if total else 0,
        "criticals":        criticals,
        "critical_rate":    criticals / total if total else 0,
        "escalations":      escalations,
        "escalation_rate":  escalations / total if total else 0,
        "p50_ms":           p50,
        "p95_ms":           p95,
        "confusion":        dict(confusion),
        "results":          results,
    }


# ── Print report ──────────────────────────────────────────────────────────────

def print_report(metrics: dict, budgets: dict) -> bool:
    """Print metrics and return True if all budgets are met."""

    GREEN = "\033[32m"; RED = "\033[31m"; YELLOW = "\033[33m"
    BOLD  = "\033[1m";  DIM = "\033[2m";  RESET  = "\033[0m"

    def pct(n): return f"{n*100:.1f}%"
    def ok(val, budget, lower_is_better=True):
        if budget is None:
            return True
        return val <= budget if lower_is_better else val >= budget

    print(f"\n{BOLD}🍝 LLMSpaghetti Router Eval{RESET}")
    print(f"   {metrics['total']} fixtures\n")

    passed = True

    rows = [
        ("Misroute rate",    metrics["misroute_rate"],   budgets.get("max_misroute"),   pct),
        ("Critical misroutes",metrics["critical_rate"],  budgets.get("max_critical"),   pct),
        ("Escalation rate",  metrics["escalation_rate"], None,                          pct),
        ("Latency p50",      metrics["p50_ms"],          None,                          lambda v: f"{v:.0f}ms"),
        ("Latency p95",      metrics["p95_ms"],          budgets.get("max_p95_ms"),     lambda v: f"{v:.0f}ms"),
    ]

    for label, value, budget, fmt in rows:
        status = ""
        if budget is not None:
            if ok(value, budget):
                status = f"{GREEN}✓ (budget {fmt(budget)}){RESET}"
            else:
                status = f"{RED}✗ OVER BUDGET {fmt(budget)}{RESET}"
                passed = False
        print(f"  {label:<22} {BOLD}{fmt(value)}{RESET}  {status}")

    # Confusion matrix
    print(f"\n{BOLD}Confusion matrix{RESET} (row=expected, col=predicted)")
    roles = sorted(VALID_ROLES - {"none"})
    header = f"  {'':>10}" + "".join(f"{r:>10}" for r in roles)
    print(header)
    for exp in roles:
        row = metrics["confusion"].get(exp, {})
        total_exp = sum(row.values())
        if total_exp == 0:
            continue
        cells = []
        for pred in roles:
            n = row.get(pred, 0)
            if n == 0:
                cells.append(f"{DIM}{'·':>10}{RESET}")
            elif pred == exp:
                cells.append(f"{GREEN}{n:>10}{RESET}")
            elif is_critical(pred, exp):
                cells.append(f"{RED}{n:>10}{RESET}")
            else:
                cells.append(f"{YELLOW}{n:>10}{RESET}")
        print(f"  {exp:>10}" + "".join(cells))

    # Misses
    misses = [r for r in metrics["results"] if not r["correct"]]
    if misses:
        print(f"\n{BOLD}Misroutes ({len(misses)}){RESET}")
        for r in misses:
            crit = f"{RED} ⚠ CRITICAL{RESET}" if r["critical"] else ""
            print(f"  [{r['id']}]{crit}")
            print(f"    expected={r['expected']} got={r['predicted']} tier={r['tier']}")
            if r["note"]:
                print(f"    {DIM}{r['note']}{RESET}")

    print()
    if passed:
        print(f"{GREEN}{BOLD}✓ All budgets met{RESET}")
    else:
        print(f"{RED}{BOLD}✗ Budget(s) breached{RESET}")

    return passed


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="LLMSpaghetti router eval harness"
    )
    parser.add_argument(
        "--classifier",
        default=None,
        help="module:function to test, e.g. mymodule:classify (default: reference)"
    )
    parser.add_argument(
        "--fixtures",
        nargs="+",
        default=["eval/fixtures_base.jsonl"],
        help="fixture files or dirs (default: eval/fixtures_base.jsonl)"
    )
    parser.add_argument(
        "--max-misroute",
        type=float,
        default=0.10,
        help="max misroute rate (default 0.10)"
    )
    parser.add_argument(
        "--max-critical",
        type=int,
        default=0,
        help="max critical misroutes (default 0 — none allowed)"
    )
    parser.add_argument(
        "--max-p95-ms",
        type=float,
        default=600,
        help="max p95 added latency in ms (default 600)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="print each misroute as it happens"
    )
    args = parser.parse_args()

    # Load classifier
    if args.classifier:
        classifier_fn = load_classifier(args.classifier)
    else:
        classifier_fn = reference_classify

    # Load fixtures
    fixture_paths = [Path(p) for p in args.fixtures]
    fixtures = load_fixtures(fixture_paths)
    if not fixtures:
        print("[ERR] No fixtures loaded.", file=sys.stderr)
        sys.exit(2)

    # Run
    metrics = run_eval(fixtures, classifier_fn, verbose=args.verbose)

    # Report
    budgets = {
        "max_misroute": args.max_misroute,
        "max_critical": args.max_critical / len(fixtures) if fixtures else 0,
        "max_p95_ms":   args.max_p95_ms,
    }
    passed = print_report(metrics, budgets)

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
