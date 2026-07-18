# 🍝 PLANNED — Smart Routing (the 3-vote ensemble)

> Status: **designed, not built.** Captured from a long design conversation so it
> doesn't evaporate. Most of the pieces already exist — this is about wiring them
> together, not inventing them.

This is the near-term, per-user, opt-in classifier design. It is the *framework* the
long-term [community-trained router model](PLANNED-router-model.md) eventually plugs
**into** — that model becomes one of the swappable context models here, not a
separate system.

---

## The core principle

> **The router always answers. "I don't know" is a route to `general`, never a refusal.**

The cascade always terminates. It gets *smarter* about which model as the signals get
stronger, but the worst case is a capable general answer — never a shrug or an error.

**The one deliberate exception:** the private/local role
([PLANNED-private-role.md](PLANNED-private-role.md)). If a message is meant to stay
local and its model is down, silently falling back to a *cloud* model would leak
private data — so there it fails **loudly**. That exception proves the principle:
always answer with `general`, except the one role whose entire point is not leaking.

---

## Three votes, side by side

The strength comes from **decorrelated signals** — they fail in different ways, so for
all three to be wrong, three unrelated mechanisms had to break the same way.

| voter | reads | cost | ships |
|---|---|---|---|
| **keyword** | surface words (regex) | ~free | standard |
| **kNN** (nomic-embed-text + vector store) | *memory* — past corrections, local + community | one embed (~10-50 ms) | standard |
| **context model** (e.g. `qwen3:0.6b`) | *meaning* — a small LLM's semantic read | ~100-300 ms | **opt-in** |

A strict cascade throws the ensemble away by early-returning on the first hit — you
never *get* the agreement. Side-by-side keeps every signal alive so agreement
compounds and **disagreement becomes a feature** (it's the "genuinely ambiguous →
ask the model / flag for review" signal).

---

## Two hierarchies — don't conflate them

- **Compute order** — what you *calculate* first: cheap → expensive, to short-circuit
  and save the expensive call.
- **Authority order** — whose vote *wins* on conflict.

The context model is **last in compute** (priciest) but **high in authority** (a
semantic read outranks a brittle keyword). *When* it runs ≠ *how much it counts.*

```
authority:  golden  >  context model ≈ kNN  >  keyword
compute:    golden  →  keyword  →  kNN  →  context model  →  combine
```

---

## How one message flows

```
1. canonical golden?  →  yes: route. (you labelled this — known answer, done)

2. run keyword + kNN  (both cheap, side by side)
      both certain AND agree?  →  route. (corroborated, free — no model call)

3. anything less — uncertain, OR they conflict, OR the guess points somewhere
   expensive  →  wake the context model, add its vote

4. COMBINE, weighted by each signal's own certainty:
      sum(role) = knn_conf·knn(role) + model_conf·model(role) + keyword_hit(role)
      route = argmax(sum)

5. route to the top vote.  general only when NOTHING leans.
```

---

## The arbitration

### Golden — trust by source, in two tiers

A **golden** entry is a correction you verified (or a community one that passed the
eval gate). A verified human label is an *instruction, not a vote* — but override
strength depends on how tightly the message matches:

```
Canonical golden  (normalized: whitespace/punct/case folded)  → absolute override
Neighbour golden  (embedding match, i.e. kNN)                 → weighted vote
```

Two tiers, not three. Byte-exact adds nothing over canonical — for *intent*,
whitespace and case never matter, and the router's exact tier already normalizes. The
canonical fold is what stops `How do I install Ollama?` / `ollama?` / `Ollama!!` from
becoming three separate goldens. A loose neighbour at 0.7 is a *strong vote*, never
law — so one fuzzy match can't hijack everything near it.

### The combine — weighted by self-certainty (no tuned constants)

```
sum(role) = knn_conf·knn(role) + model_conf·model(role) + keyword_hit(role)
route      = argmax(sum)
```

Each signal is weighted by **how sure it is of itself**, so a signal that doesn't know
shuts up on its own — no hand-tuned weights to calibrate:

- `knn_conf` = top-neighbour similarity → a blank kNN contributes ≈0
- `model_conf` = margin between the model's top-2 → a split read (0.75/0.72) whispers;
  a confident one (0.9/0.1) dominates

Then:

- **agree** (independent signals concur) → route + **store as golden-candidate** (next
  time it's an instant canonical/keyword hit — *no model call*)
- **disagree** → most-confident wins (margin); if the winner is still weak → the
  `general` floor

### When does the context model vote?

**Skip it only when keyword and kNN are both certain AND agree.** Everything else
invites it:

| keyword | kNN | → |
|---|---|---|
| certain | certain, **agree** | route, skip the model (free) |
| certain | certain, **conflict** | **model decides** |
| certain | uncertain | model confirms / vetoes the lone signal |
| uncertain | certain | kNN leads (your data); model optional |
| uncertain | uncertain | **model decides** |

Plus a **cost gate**: run the model whenever the tentative route points at an
*expensive* model. A misroute to a big cloud model costs money + quota + a bad answer
+ a retry; 200 ms of local inference is nothing against that. **Rank the model by
cost-of-being-wrong, not cost-of-running.**

---

## Guess, don't hide

Always take the argmax. `general` is for *no* signal, not *weak* signal — a lean of
`document 0.4` beats `general 0.1`, so route to document. A router that retreats to
`general` whenever unsure **never learns**, because it never generates the decisions
you can correct.

```
best guess  →  visible provenance  →  user correction  →  golden forever
```

A wrong guess costs one ✎ click and makes the router *permanently* smarter. A timid
retreat costs nothing today and teaches nothing.

**What makes guessing safe: misroutes must be visible.** The provenance tag
(`↳ LLMSpaghetti → model · document`) shows the pick on every reply, so a wrong guess
is *seen* → you hit ✎ fix → golden. Aggressive routing + visible provenance +
one-click fix = the loop closes. The tag is the safety mechanism for the low floor.

**Modulated by cost:** guess *freely* toward a cheap local model (a miss costs a
click); *double-check* with the context model before spending an expensive cloud call
on a hunch.

---

## Each vote is explicit (for debugging, not routing)

Every voter returns not just a role + confidence but its **evidence**:

```
keyword       { role: code, confidence: 0.95, reason: "matched /python|traceback/" }
kNN           { role: code, confidence: 0.88, reason: 'nearest "pip install fails" @0.08' }
context model { role: code, confidence: 0.91, reason: "asking for debugging" }
```

The reasons don't affect routing — they make "**why did it pick code?**" answerable by
inspecting the votes. This extends what exists: `Classification` already carries a
`reasoning` field, and the router already logs tiers + emits `x_llmspaghetti` (the
SpagDesk Router Insight panel + the ✎-fix routing log). The change is carrying *all
three* votes with their evidence, not just the winner.

### Two confidences, not one

Confidence secretly mixes two things — split them:

- **classification confidence** — "I think this is code."
- **coverage confidence** — "I actually understood the message."

`"Can you help me?"` → `general 0.72` (classification looks fine) but coverage `0.12`
(nothing meaningful understood). Coverage's real job is a **trust gate on the
classification, especially toward expensive models**: `code 0.6` with coverage `0.15`
means that 0.6 is untrustworthy — don't burn an Opus call on it, route `general`
instead. **Coverage = permission to spend.**

Honest scope: coverage is clean for **keyword** (did anything match at all?) and
**kNN** (nearest distance) — and we half-get it free, since `knn_conf` *is* coverage-
ish. It's **murky for the LLM** (asking a model "did you understand?" is another
untrustworthy self-report), so compute it where it's clean and don't fake it.

---

## The opt-in context model

nomic (kNN) is ~274 MB and cheap, so it's standard. A *generative* classifier is a
real hardware commitment, so it's **opt-in** — standard-in-spirit, opt-in-in-practice.

### Install = active. Uninstall = off. One decision.

The install **is** the opt-in — no separate "activate" step. Once installed it's a
**first-class tier**, core by design, not a bolted-on plugin. Four states:

```
not installed      → tier doesn't exist
installed + active → full member of the vote, warm on startup   (default)
installed + paused → skipped but on disk, instantly resumable   (the A/B switch)
uninstalled        → gone, RAM + disk freed
```

The **pause** exists purely to answer *"is this actually helping my routing?"* without
deleting and re-downloading a multi-GB model.

### Swappable model

Don't hardcode. `classifier_model` (mirrors the existing `EMBED_MODEL`), default a
good small one, swap freely: `qwen3:0.6b`, `qwen3:1.7b`, `gemma3:1b`, `llama3.2:1b` —
tiny-and-fast vs slightly-smarter, user's call. The community-trained
[router model](PLANNED-router-model.md) drops in here too.

### CPU by default, GPU by choice

Just Ollama's `num_gpu` — **already used** by the image VRAM handoff, so no new
plumbing:

```
classifier_device:  cpu (num_gpu:0, default) | gpu (num_gpu:999) | auto (omit)
```

Default **CPU**, even on a VRAM-rich box, because the classifier gains little from VRAM
(not latency-critical — only fires on *uncertain* messages) and the VRAM cost is real
(it'd compete with / be evicted by chat + image models — the exact thrash the image
handoff already fights). Flip to `gpu` in one setting if you have headroom.

### Auto-warm on startup

If installed + active, the router fires a **background** warmup at boot (empty
generate, `keep_alive:-1`, device per setting) so it's resident and ready — no
cold-load penalty on the first hard message, no babysitting. Non-blocking: the router
comes up instantly and uses keyword+kNN until it's warm.

### Graceful fallback (hard rule)

Even as "core", if the model fails to load (OOM, corrupt pull) the router **still falls
back to keyword+kNN** and logs why. Opt-out = you lose the semantic vote, everything
else routes unchanged. **Keyword is the cold-start floor** — the only tier that works
with an empty correction store and no model pulled, so a fresh box routes on day one.

---

## Calibration (log day 1, compute later)

For every prediction, log `(voter, predicted_confidence, was_corrected)`. Later,
compute each voter's real reliability:

```
keyword   predicts 0.95, actually right 97%   → well-calibrated
kNN       predicts 0.90, actually right 64%   → overconfident → down-weight
```

This is the *empirical* version of "weighted by self-certainty" — the weights become
measured instead of assumed, and you recalibrate each voter **without touching routing
logic**.

**Honest caveat:** ground truth here is *corrections*, which are biased toward errors
(people click ✎ on wrong routes, rarely confirm right ones). So count "not corrected"
as a weak positive and treat the numbers as directional. **Log the raw tuples from day
one** (cheap); compute calibration only once there's volume.

---

## The front-page contract (honest cost + measured value)

> **Smart routing (opt-in).** A small local model votes on the messages keyword +
> memory can't classify. Runs on **CPU by default** (~0.6-1.5 GB **RAM**, not VRAM) —
> flip to GPU if you have headroom. **Auto-loads on startup**, stays resident. Off =
> clean fallback to keyword + memory. Model is **swappable**.
>
> *This week: 82% routed free (keyword/kNN), 18% used the model, N misroutes prevented.*

State *where* it helps (the hard cases), not a vague "increases hit-rate." The
telemetry is the honest counterpart to the cost warning — since we already track which
tier resolved each message, **show it**, and turn "trust me" into their own numbers.

---

## What already exists vs what to build

**Exists (why execution risk is low):**
- The LLM tier *slot* — `build_classifier(llm_fn=...)` + `_llm_tier` in
  [eval/classifier.py](../eval/classifier.py) (stubbed; the router calls `classify()`
  with no `llm_fn`).
- **kNN** — `_fuzzy_override` in [router/main.py](../router/main.py) on the miss path
  today (canonical override → keyword → fuzzy kNN → general).
- **nomic-embed-text** ships standard (auto-pulled on install).
- **`num_gpu` device control** — already used by the image VRAM handoff.
- **provenance tag + correction API + routing log** — the visibility + fix loop.
- **eval harness** — the gate every change answers to.

**To build:**
- `classify_scores(message, ctx) -> {role: score}` context-model call (JSON-mode
  constrained output, thinking off, temp 0).
- The weighted side-by-side combine + canonical-golden override, replacing the plain
  cascade at the miss path; explicit per-voter vote objects + coverage confidence.
- Config: `classifier_model`, `classifier_device`, install/pause state; startup
  warmup; per-tier resolution + calibration telemetry.
- Routing-tab UI: opt-in install, pause/resume, device toggle, cost + hit-rate copy.

### Build in slices (each shippable, opt-in, eval-gated)

1. Context-model tier wired on the miss path, single-label, CPU, behind the opt-in —
   just "if keyword+kNN missed, ask the model." Prove it beats the plain fallback on
   the eval set.
2. Structured vote objects + the two confidences, surfaced in the routing log.
3. The weighted combine (logprob/margin scores) + agree→golden-candidate capture.
4. Calibration logging (raw from day 1) → later, measured weights.

### Two implementation notes

- **The model's JSON scores are a *ranking*, not calibrated probabilities.** A small
  model's self-reported numbers are directionally right, magnitude-fictional — trust
  the order, be skeptical of exact margins. Real margins come from **logprobs** on the
  role token (a v2; thin Ollama support). For v1, treat scores as an ordinal vote.
- **Don't fuse the two vectors.** The model's role-scores (`{code:0.87,…}`, ~6 numbers,
  a *vote*) are **not** an embedding. The vector store holds **nomic embeddings**
  (768-dim, searched by similarity — the *memory* signal). They meet at the combine
  step; the model never feeds the store.

---

## Related documents

- [PLANNED-router-model.md](PLANNED-router-model.md) — the long-term community-trained
  model that plugs in here as a swappable classifier
- [PLANNED-routing-fixture-flywheel.md](PLANNED-routing-fixture-flywheel.md) — how
  corrections become golden (soft-merge + eval gate)
- [PLANNED-private-role.md](PLANNED-private-role.md) — the one role that fails loudly
  instead of falling back
- [eval/classifier.py](../eval/classifier.py) — the tiered classifier + the LLM slot
- [eval/eval_router.py](../eval/eval_router.py) — the eval gate every change answers to
