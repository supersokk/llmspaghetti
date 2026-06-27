# 🧭 Client strategy — one smart endpoint, thin clients

> Status: decided direction (2026-06-27). Custom chat is the END-GAME, not
> near-term. This doc records WHY it's viable and the rule that protects it.

## The principle

LLMSpaghetti exposes **one API endpoint** (`/v1`). The **backend (router) does
all the intelligence**: classification, routing, fallback, provenance tagging,
and eventually background jobs. Every client is a thin consumer of that one
endpoint.

```
   Open WebUI (now)  ─┐
   VS Code ext (next) ─┼──→  http://host/v1  ──→  Router (ALL the smarts)
   Our own chat (end) ─┘                            ↳ classify, route, tag, jobs
```

Because the smarts live behind the endpoint, swapping or adding a client is a
new *face*, not a new *product*. This is what makes owning the chat eventually
affordable instead of a rewrite.

## The decision

- **Near-term:** Open WebUI stays the chat. We keep using it.
- **Mid-term:** the VS Code extension (thin client, already planned, Phase 9).
- **End-game:** our own chat/window, for full control and freedom over the
  experience (background jobs, rich provenance, auto/single switch, anything).
  This is a long-term, community-driven goal — "nothing is impossible" — not a
  next-session task. It is justified by control, not by routing capability
  (routing is already done in the backend).

## The rule that protects the end-game

**Put logic in the router, not in client-specific glue.**

Anything built into an Open WebUI plugin must be rebuilt for the next client.
So default to doing it in the backend:

| Feature | Where it goes | Why |
|---|---|---|
| Provenance tag (`↳ answered by X`) | **Router** appends to response | Works in every client, now and future, for free |
| Role classification / routing | **Router** | The product; never client-side |
| Fallback handling | **Router** | Same |
| Background job queue + logic | **Router / backend** | Client only *displays* results |
| Up/down vote *button* | Client (unavoidable UI) | But the vote *handler* is backend |
| Job result *display* | Client (Cockpit Jobs panel / chat) | Logic stays backend |

Test for "should this be a client plugin?": **would it have to be rebuilt when
we swap clients?** If yes, push it into the router instead.

## Cost honesty (unchanged)

A full custom chat is 2-4 months and permanent maintenance of the
least-differentiated part of the stack (streaming, markdown, history, uploads,
images, mobile, auth) — all of which Open WebUI maintains for free. That cost
is accepted *as an end-game for control*, with eyes open, not as a near-term
move. Revisit only after multi-model routing and the backend tag are proven.

## Related
- [PLANNED-background-jobs.md](PLANNED-background-jobs.md) — a key reason the end-game client exists
- [PLANNED-model-management.md](PLANNED-model-management.md)
- TODO Phase 9 (VS Code extension — the thin client we build first)
