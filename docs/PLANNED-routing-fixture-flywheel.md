# 🍝 PLANNED — Routing Fixture Flywheel

> Status: design, not built. This is the plan for how LLMSpaghetti's intent
> router learns from use — locally first, then community-wide — without ever
> requiring a central service and without shipping anyone's prompts upstream.
>
> Community input welcome. The math here is illustrative; the parameters are
> meant to be tuned, not trusted.

---

## What this is

The router decides which model answers each message (see model roles in
PROJECT-SCOPE.md). It will get things wrong. This document describes how a
wrong route gets corrected — and how that single correction improves the
user's own box immediately, and the whole project eventually.

Two clocks, running at different speeds:

- **The user's box gets smarter the instant they tap "wrong role."** No
  restart, no retrain, no network.
- **The project gets smarter per release**, as opt-in corrections flow
  upstream, get vetted, and come back down in the next base fixture set.

One mechanism drives both. That's the point of this design — it is not three
separate systems, it's one nearest-neighbor store read at inference time and
written at correction time.

---

## The core idea

A correction is not retraining. It is one row the router already reads.

The router's expensive tier is a vector nearest-neighbor lookup (kNN over
embedded fixtures — Qdrant is already in the Phase 5 stack). A "fixture" is
just `(embedding, role, metadata)` meaning *"requests shaped like this route
here."* A user correction is the same record with `source: local`. So:

- **Tap "wrong role"** → append `(embedding, corrected_role, context)` to a
  local store and upsert the vector. Done. The next similar message hits it as
  a neighbor and routes correctly.
- **Same mechanism, different source** is how community fixtures work too.

Because corrections and community fixtures are the same kind of object, the
"how do I reconcile my corrections with a project update" question becomes a
single tunable: **how much weight does a local vote carry against a community
vote.** Three named settings of that one knob are described below.

---

## Architecture

### Tier order

```
signal      deterministic   attachments, code blocks, token count   ~0ms
keyword     deterministic   clean trigger words, collision-guarded   ~0ms
overrides   kNN (local)     the user's own corrections               ~ms
fixtures    kNN (community) ships with the release                   ~ms
llm         model call      genuine ambiguity only                   ~100ms+
fallback    —               model returned junk → general            —
```

Local overrides are queried **before** community fixtures and win ties by
default — it's the user's box and their context. Both kNN tiers sit between
keywords and the LLM tier, so every correction (local or community) reduces
escalations: cheaper *and* more accurate at once, which is the flywheel.

### Two stores, kept separate on purpose

| Store | File | Lifecycle |
|---|---|---|
| Local overrides | `overrides_local.jsonl` | Append-only. **Never touched by updates.** |
| Community base | `fixtures_base.jsonl` | Ships with the release. Replaced on `spag update`. |

The vector index (Qdrant collection, or a flat vector file on a single node)
is built from both, in **two namespaces** so local can be queried first and
weighted independently.

### The correction record

```json
{
  "predicted_role": "fast",
  "corrected_role": "document",
  "tier_that_fired": "keyword",
  "context": {
    "has_file_attachment": true,
    "has_code_blocks": false,
    "token_count": 9000,
    "thread_role": null
  },
  "embedding": [0.0123, -0.0456, "..."],
  "embedding_model": "nomic-embed-text:v1.5",
  "message": "give me a quick summary of this 40-page contract",
  "source": "local",
  "created_at": "2026-06-26T08:00:00Z",
  "corroboration": 1,
  "tombstoned": false
}
```

`message` holds full text **locally only**. It is stripped at the export
boundary (below). `embedding_model` is pinned because kNN only works across
vectors from the same model — see Gotchas.

---

## Flow 1 — "improve right now" (fully local)

1. **Tap → write.** Reuse the embedding the classifier *already computed* for
   that request (cache it on the response; never re-embed at tap time).
   Append the record to `overrides_local.jsonl`, upsert the vector into the
   local namespace.
2. **Effect, immediately.** The next message whose embedding is near that
   vector is caught by the override tier and routed to `corrected_role`
   (tier = `override`). No restart.
3. **Undo.** A mis-tap sets `tombstoned: true` and removes the vector by id.
   Tombstone, never hard-delete — reversibility is cheap if designed in now.

Nothing leaves the machine in this flow. This is the whole loop for a user who
never contributes upstream, and it still makes their router better.

---

## Flow 2 — export (the privacy boundary)

**The privacy boundary is the export step, not the capture step.** Locally,
keep full text — it's their machine and richer data debugs better. Stripping
happens only when crossing to upstream.

`spag fixtures export` (or a UI button) gathers local, non-tombstoned
corrections and produces a shareable `contributions.jsonl`:

- **Default payload: embedding + metadata only. `message: null`.** A vector is
  pseudonymous, not human-readable, and is exactly what the community kNN tier
  needs. Most signal-tier and sticky-tier corrections need no text at all
  (`file + 9000 tokens + fired fast → document` is a complete fixture).
- **Show-and-confirm.** The exact payload is displayed before anything is
  written. If the user chooses to include text for a collision-class case, a
  redaction pass (regex/NER for emails, keys, long digit runs, local paths)
  runs first, and they edit/approve the result. One-tap becomes
  one-tap-then-confirm at this boundary, which is the only honest version.
- **Off by default, opt-in, revocable**, with plain-language wording:
  *"This sends an embedding and metadata, never your message text."*

Honest-not-impressive applies hardest to our own privacy claims: say
"pseudonymous," not "un-invertible." Embeddings leak *some* information.

The user then PRs or uploads `contributions.jsonl`. Maintainers vet, dedup,
and **increment `corroboration`** when independent users corrected the same
shape the same way (this count is what makes soft merge meaningful — see
below). A maintainer-curated **golden eval set** with consented or synthetic
text is kept *separate* from the contributed pool, so the accuracy number
never leaks from data also used as routing examples.

---

## Flow 3 — merge-back (per release)

`spag update` pulls the new `fixtures_base.jsonl` and rebuilds the **community
namespace only**. `overrides_local.jsonl` is **untouched** — the user keeps
every personal correction *and* gains everyone else's.

After the swap, local and community fixtures coexist. They only need
reconciling where they **conflict**: same vector neighborhood, different role.
That's a small, detectable set, not a database merge.

---

## The three update choices

When a release arrives, the user picks how their local overrides relate to the
incoming community fixtures. **These are three settings of one knob — the
weight a local vote carries — not three code paths.**

| Choice | Meaning | Implementation |
|---|---|---|
| **Keep local** (default) | My taps always win | local weight → ∞ in conflict zones |
| **Take community** | The project learned this better than my one tap | local weight → 0 for the conflicting shape |
| **Soft merge** | Let them vote; consensus can outweigh a stale tap | both finite; weighted vote |

Presented as a global "apply to all" choice with an optional per-conflict
review list for power users. Do **not** throw a modal at a non-technical user
mid-update — default to keep-local and move on.

---

## Conflict detection (at update time)

```
for each local override O (not tombstoned):
    N = kNN(O.embedding) over the NEW community namespace, top 1
    if N.similarity >= CONFLICT_THRESHOLD and N.role != O.corrected_role:
        record conflict(O, N)
# everything else coexists untouched
```

Only conflicts are subject to the three-way choice. Non-conflicting local
overrides always remain active. `CONFLICT_THRESHOLD` is a config knob
(start ~0.90).

---

## The vote math (soft merge)

At inference, take the top-k neighbors across both namespaces. Each neighbor
votes for its role with weight = **similarity × source_weight**. Sum per role,
route to the argmax.

```
score(neighbor) = similarity × source_weight

source_weight(local)     = L                       (× optional staleness decay)
source_weight(community) = C_base × (1 + α·ln(n))   n = corroboration count
```

Illustrative defaults (tune against the eval harness, do not trust as given):

```
L       = 1.0     local base weight
C_base  = 0.5     community base — a single community fixture (n=1) is
                  deliberately HALF a local tap, so it can't override your
                  correction on its own
α       = 0.5     how fast community consensus accrues weight
```

`source_weight(community)` at a few corroboration counts:

| n (independent corrections) | community weight |
|---|---|
| 1  | 0.50 |
| 3  | 0.77 |
| 6  | 0.95 |
| 10 | 1.08 |
| 25 | 1.30 |

So community reaches parity with a fresh local tap (at equal similarity)
around **n ≈ 6–10**. Below that, your local correction holds. This is the
honest crux: **soft merge only beats keep-local if the merge step records
corroboration counts.** One community fixture vs. one local tap is a
similarity coin-flip; soft earns its keep when "6 people agreed" can outweigh
"I tapped this once, months ago."

### The named modes as parameter settings

- **Keep local:** community weight forced to 0 in conflict zones (`C_base = 0`
  there). Trivially explainable: *"routed by your override."*
- **Take community:** local weight forced to 0 for that shape. Also trivial.
- **Soft merge:** both finite, formula above. Optional staleness decay
  `L × exp(-age/τ)` lets a fresh consensus overtake an old tap; default decay
  **off** so behavior isn't surprising.

### Worked examples (soft merge)

**A — fresh local tap vs. loose community.** Your correction should hold.
```
local:     s=0.97, w=1.0           → score 0.970
community: s=0.83, n=4  → w=0.78   → score 0.647
→ local wins ✓
```

**B — stale weak local vs. strong fresh consensus.** Consensus should win.
```
local:     s=0.86, decay=0.5 → w=0.5  → score 0.430
community: s=0.88, n=12 → w=1.12      → score 0.986
→ community wins ✓
```

**C — keep-local mode.** Community weight 0 → local always wins regardless of
n or similarity. Predictable and explainable.

---

## Gotchas to design for now, not later

- **Embedding-model pin breaks soft merge specifically.** Conflict detection
  and voting compare vectors; a release that changes the embedding model makes
  local and community vectors **incomparable** and disables soft merge until
  re-embed. Metadata-only fixtures survive a model swap; embedding-only ones
  are bound to a model version. Record `embedding_model` on every record and
  plan the re-embed path (needs the local text, which is why keeping text
  locally matters) before you're forced into it.
- **Inspectability.** Keep-local and take-community are one-line explanations.
  Soft merge makes routing a weighted vote, which for an honest project must
  not be a black box. Let the "answered by X" indicator explain *why* on
  demand: matched your override / community consensus (n=…) / weighted vote
  over these neighbors.
- **Reversibility everywhere.** Tombstone, don't delete. "Take community" that
  disappoints must be restorable to the local override. Cheap if built in up
  front, painful to retrofit.
- **Threshold knobs exposed.** `CONFLICT_THRESHOLD`, the kNN route threshold,
  `k`, and the weight params all need to be config, because too-loose bleeds
  one correction into unrelated requests and too-tight only catches near-exact
  repeats.

---

## Recommended sequencing

Build the **data model** for all three modes now — two namespaces,
corroboration counts, tombstones, `embedding_model` pin, and per-route voter
logging. But **ship keep-local + take-community first.** Turn on soft merge
only once the community corpus is dense enough that corroboration counts mean
something. Early on, fixtures are sparse and single-sourced, so soft merge ≈
keep-local with extra moving parts. Add the sophistication when the data earns
it — and don't close the door on it in the schema.

---

## Open questions for contributors

- What's the right re-embed strategy when the embedding model changes between
  releases, given embedding-only contributors have no text to re-embed?
- Should corroboration be a flat count, or weighted by reviewer trust /
  recency? A flat count is gameable if uploads aren't vetted.
- Per-conflict review UX for power users without overwhelming normal users —
  what's the right default surface?
- Does the override tier need a cap (max active local overrides) before kNN
  recall degrades on a single node, and where is that limit in practice?
