# 🍝 PLANNED — Community Router Model

> Status: idea, not started. Documented here so it isn't forgotten
> and so the right contributor can find it.
>
> This does not require the core team to do anything.
> It requires one person with ML skills and enough fixture data.
> Both of those things will exist eventually.

---

## The idea

As the LLMSpaghetti community accumulates routing fixtures over time,
there will eventually be enough labelled data to fine-tune a small
open source model specifically for the LLM routing task.

Instead of a general-purpose model doing classification as a side task,
this would be a purpose-built router model — trained on real user intent
data from real LLMSpaghetti usage — that does one thing extremely well:

> Given a message and context, return the correct routing role.

---

## Why it's interesting

**It's a narrow task.** Classification into 7 roles doesn't require
a large model. A 1B parameter model fine-tuned specifically for this
probably beats a general 7B model doing it as an afterthought.

**It would be fast.** Narrow task = fewer tokens = faster inference.
Sub-10ms classification on CPU is realistic. That kills the latency
argument against the LLM classifier tier entirely.

**The training data builds itself.** Every fixture contributed by every
community member is labelled training data. The corpus grows automatically
as the community grows. No annotation team needed.

**It would be genuinely useful beyond LLMSpaghetti.** Any project that
needs to route LLM requests — and there will be many — could use a
purpose-built open source router model. LLMSpaghetti would be where
it came from.

---

## What it would look like

```
huggingface.co/llmspaghetti/router-v1

  Fine-tuned for intent classification in LLM routing.
  Trained on community fixtures from the LLMSpaghetti project.

  Input:   user message + context flags
  Output:  one of [image, code, reasoning, fast, document, general, none]

  Accuracy:  97%+ on held-out eval set
  Size:      ~1B parameters, ~680MB
  Latency:   ~8ms on CPU, ~2ms on GPU
  License:   Apache 2.0 (weights) / GPL v3 (training data)
```

Users set it as their classifier role:
```bash
ollama pull llmspaghetti/router:v1
# then in LLMSpaghetti: Models → router-v1 → role: classifier
```

---

## Version roadmap (aspirational)

```
router:v1    — first fine-tune, ~5,000 fixtures
               proves the concept

router:v2    — more data, better edge cases
               ~20,000 fixtures

router:v3    — multilingual
               non-English fixture contributions

router:lite  — ~300M params, runs on anything
               slightly less accurate, much faster

router:pro   — ~3B params
               handles very ambiguous cases
```

All versions measured against the same eval harness.
All comparable. Community picks what fits their hardware.

---

## What needs to exist first

Before this makes sense to attempt:

- [ ] At least 1,000 community-contributed fixtures
      (we have 31 today — enough to start, not enough to train)
- [ ] Fixture quality review process working
      (corroboration counts, maintainer vetting)
- [ ] Held-out eval set separate from training data
      (so accuracy numbers are honest)
- [ ] Someone with fine-tuning experience
      (LoRA on Phi-3 Mini or Gemma 2B is the likely approach)
- [ ] Hugging Face account for the llmspaghetti org

---

## How the training data works

The fixture corpus from `community/fixtures/` is the training data.
Each fixture is:

```json
{
  "message": "give me a quick summary of this contract",
  "expected": "document",
  "context": {"has_file_attachment": true, "token_count": 9000}
}
```

Which maps directly to a fine-tuning example:

```
Input:  [MESSAGE] give me a quick summary of this contract
        [CONTEXT] has_file=true tokens=9000
Output: document
```

The privacy design already handles this — contributed fixtures have
message text that contributors explicitly consented to share publicly.
The training data is clean by design.

---

## The eval harness is already the benchmark

Whatever model gets fine-tuned, it gets measured against
`eval/eval_router.py` with the same budgets:

```bash
python3 eval/eval_router.py \
  --classifier llmspaghetti_router:classify \
  --max-misroute 0.05 \
  --max-critical 0
```

If it beats the keyword classifier — it ships.
If it doesn't — it doesn't. The numbers decide, not opinions.

This means router model versions are directly comparable.
`router:v2` either beats `router:v1` on the eval set or it doesn't.

---

## Who could do this

This task needs:
- Familiarity with LoRA / QLoRA fine-tuning (HuggingFace PEFT library)
- Access to a GPU for a few hours (a rented A100 for an afternoon)
- Understanding of the fixture format and eval harness
- Willingness to publish weights on Hugging Face

It does NOT need:
- Deep ML research experience
- A large compute budget
- Permission from the core team

If you're reading this and you have those skills —
the fixture corpus is in `community/fixtures/`
the eval harness is in `eval/eval_router.py`
the contract is `classify(message, ctx) -> Classification`

The door is open. 🍝

---

## Related documents

- [PLANNED-smart-routing.md](PLANNED-smart-routing.md) — the 3-vote ensemble this model plugs into as a swappable context model
- [eval/README.md](../eval/README.md) — how the eval harness works
- [community/fixtures/README.md](../community/fixtures/README.md) — how to contribute fixtures
- [docs/PLANNED-routing-fixture-flywheel.md](PLANNED-routing-fixture-flywheel.md) — the full flywheel design
- [PROJECT-SCOPE.md](../PROJECT-SCOPE.md) — overall project scope

---

## Open questions for whoever takes this on

- LoRA on Phi-3 Mini or Gemma 2B — which base model?
- How to handle the context flags (has_file, token_count) as model input?
- What's the minimum fixture count before fine-tuning is worth attempting?
- How to structure the held-out eval set without leaking from training data?
- Apache 2.0 for the weights, GPL for the training data — is that clean legally?
- Should the model output a confidence score alongside the role?

These are good questions to open as GitHub Discussions.

---

*The best open source projects accidentally produce things more
valuable than what they set out to build. This might be one of them.*
