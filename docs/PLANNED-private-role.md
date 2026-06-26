# ⏸ PLANNED — Private Role

> **Status: Not implemented. Needs serious design thinking first.**
>
> Do not build this until the questions below are answered properly.
> This file exists to capture thinking, not to specify implementation.

---

## Why this is paused

"Private" implies a guarantee about data protection. Guarantees about
data protection in software are easy to get wrong and hard to get right.
Getting it wrong misleads users who may trust us with genuinely sensitive
data. That's not acceptable for a hobby project or any project.

We are a routing layer. We can make honest promises about routing.
We cannot easily make honest promises about everything that happens
after routing — execution environments, MCP tools, logs, Docker volumes,
model memory, and a dozen other things.

---

## What we know so far

### What "private" would honestly guarantee
- Prompt routed to a model running on local hardware
- No cloud LLM API called for this request
- That's it

### What "private" would NOT guarantee
- What MCP tools do with the data
- What code the model writes and executes
- Whether logs capture the conversation somewhere
- Whether Docker volumes are encrypted at rest
- Whether the local model itself leaks data somehow
- Anything about the model's weights or training

### The execution environment problem
If a code runner MCP tool is active, the model can write code
that makes network requests. That code runs on the user's machine
which has normal network access. LLMSpaghetti has no control over
what that code does.

### The naming problem
"Private" implies data privacy to most people.
"Local" is more honest — it just means where the model runs.
Consider renaming to "local" entirely and dropping privacy claims.

---

## Questions that need answering before building

1. **What exactly are we promising?**
   Can we promise it clearly enough that no reasonable person
   would be misled about what's protected and what isn't?

2. **Who is the threat model?**
   - Protection from cloud providers seeing your data? (routing solves this)
   - Protection from the LLMSpaghetti machine itself logging? (harder)
   - Protection from MCP tools? (very hard)
   - Protection from other people on your network? (different problem)
   - Protection from nation-state actors? (not our job)

3. **Should we just call it "local" instead?**
   "Local" makes a routing promise, not a privacy promise.
   Honest, simple, verifiable. No implied guarantees.

4. **If we keep the name "private" — what UI warnings are needed?**
   Every screen where it appears needs to be clear about
   what is and isn't guaranteed. Is that even feasible without
   making the UI feel paranoid and unusable?

5. **What about MCP sandboxing?**
   Code runner in Docker with --network none is a real technical
   guarantee for that specific tool. But we can't sandbox everything.
   Does partial sandboxing give false confidence?

6. **Should this wait for a security-focused contributor?**
   Someone who thinks in threat models, not features.
   This might not be the right thing for a hobbyist project to own.

---

## Options on the table

**Option A — Rename to "local", drop privacy framing entirely**
- Honest about what it does (routing only)
- No implied guarantees
- Simplest to implement and communicate
- Recommended starting point

**Option B — Build it with brutal honesty in the UI**
- Every reference shows exactly what is and isn't guaranteed
- Two-level indicator: routing private ✅ / execution sandboxed ✅/⚠️
- Risk: too many warnings makes people ignore them

**Option C — Don't ship it at all in v1**
- Let community think it through
- Better to not have it than to have it wrong
- Add it properly in v2 with real thought behind it

**Option D — Partner with someone who knows security**
- Find a contributor with a security background
- Do a proper threat model
- Build it right with their guidance

---

## Related reading before designing this

- OWASP LLM Top 10 (prompt injection, data leakage)
- How other projects handle "local only" mode
- Docker --network none as a sandboxing primitive
- What "air-gapped" actually means in practice

---

## Decision log

| Date | Decision | By |
|---|---|---|
| 2024 | Paused — needs design thinking | Initial team |
| — | — | — |

---

*Don't let urgency push this into production before it's ready.*
*A wrong privacy guarantee is worse than no privacy guarantee.*
