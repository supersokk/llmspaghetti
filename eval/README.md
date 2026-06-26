# 🍝 Router Eval Harness

Measures the LLMSpaghetti intent classifier so routing can be tuned on
data instead of vibes, and so contributors can't silently regress it.

See also: [docs/PLANNED-routing-fixture-flywheel.md](../docs/PLANNED-routing-fixture-flywheel.md)

---

## Files

- `classifier.py` — the reference three-tier classifier. Also defines the
  `classify(message, ctx) -> Classification` contract every classifier must meet.
  Contains the correction record schema and data paths for the flywheel.
- `eval_router.py` — the scorer. Runs fixtures, prints metrics, exits non-zero
  when a budget is breached (works as a CI gate).
- `fixtures_base.jsonl` — core labelled cases. Ships with every release.

Community contributed fixtures live in `../community/fixtures/contributed/`.

---

## Run

```bash
# Reference classifier (keyword only)
python3 eval/eval_router.py

# Your classifier
python3 eval/eval_router.py --classifier router.intent:classify

# Custom budgets
python3 eval/eval_router.py --max-misroute 0.08 --max-critical 0 --max-p95-ms 600

# Include community fixtures
python3 eval/eval_router.py --fixtures eval/fixtures_base.jsonl community/fixtures/contributed/

# Verbose — see each misroute as it happens
python3 eval/eval_router.py --verbose
```

---

## Fixture format

```json
{
  "id": "doc-02",
  "message": "give me a quick summary of this 40-page contract",
  "expected": "document",
  "context": {"has_file_attachment": true, "token_count": 9000},
  "note": "CRITICAL: quick + file must route to document not fast"
}
```

`expected` is one of: `image` `code` `reasoning` `fast` `document` `general` `none`

`context` fields (all optional):
- `has_file_attachment` — true if user attached a file
- `has_image` — true if user attached an image
- `has_code_blocks` — true if message contains code blocks
- `token_count` — approximate message length in tokens
- `thread_role` — role of the previous message in this thread

**Add a fixture for every routing bug you find.**
A reproduced misroute is a regression test for free.

---

## Wiring your real classifier

```python
from classifier import build_classifier, Context

def my_ollama_call(message, ctx):
    # real constrained Ollama call returning ONE role string
    # use the classifier Modelfile in config/modelfiles/classifier.Modelfile
    ...

classify = build_classifier(llm_fn=my_ollama_call)
```

The harness times whatever `classify` does — latency numbers reflect your
real model the moment you wire it in.

---

## Metrics

- **misroute rate** — wrong-role fraction. The headline number.
- **critical misroutes** — the dangerous subset. Budget defaults to 0:
  - Wrongly sent to `image` (costs DALL-E money)
  - Wrongly dropped to `none` (message disappears)
  - Serious task (`document`/`reasoning`/`code`) downgraded to `fast`
- **escalation rate** — fraction reaching the LLM tier. Lower = cheaper.
  Too low usually means the cheap tiers are guessing.
- **latency p50/p95** — classifier overhead only, not answer time.
- **confusion matrix** — which roles get mistaken for which.
  Fix the real collisions, not just the aggregate.

---

## CI gate

```yaml
# .github/workflows/ci.yml
- name: Router eval
  run: python3 eval/eval_router.py --max-misroute 0.10 --max-critical 0
```

Tighten budgets as the classifier improves.
Any PR that pushes misroute rate or critical misroutes past budget fails.

---

## Long term — community router model

As the fixture corpus grows, the labelled data here becomes training
data for a purpose-built open source router model. A fine-tuned 1B
parameter model doing only this task would be faster and more accurate
than a general LLM doing classification as a side task.

If you have ML experience and want to attempt this:
see [docs/PLANNED-router-model.md](../docs/PLANNED-router-model.md)

The eval harness is already the benchmark it would need to beat.

Found a misroute? Add one line to `community/fixtures/contributed/`.
See `community/fixtures/README.md` for the full guide.

The short version:
```json
{
  "message": "what you typed (anonymise personal info)",
  "expected": "where it should have gone",
  "got": "where it actually went",
  "had_file": false,
  "note": "one sentence why"
}
```

Open a PR. We review. Everyone benefits.
