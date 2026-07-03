# 🍝 PLANNED — SpagDesk (the native workspace)

> Status: design — MVP not built. The interface LLMSpaghetti was designed to
> have. This makes the "our own chat" end-game in
> [PLANNED-client-strategy.md](PLANNED-client-strategy.md) **active**, built
> MVP-first.

---

## Why now

The router is no longer the experiment — it **is** the product. Automatic
routing, role classification, MCP tools, quotas, fallbacks, provenance, utility
routing, and now learned corrections all live inside LLMSpaghetti. Open WebUI is
a generic OpenAI client bolted to a very non-generic backend.

That mismatch is no longer theoretical — it's been paid for feature by feature:

- Utility housekeeping detected via a `### Task:` **compatibility shim**.
- Provenance forced into a **text footer** because there's no native field OWUI
  will render.
- Corrections exiled to a **separate Cockpit panel** instead of living next to
  the message.
- `ENABLE_OLLAMA_API=false` to stop the client bypassing the router.

Every new router capability runs into *"how do we expose this through OWUI?"* A
native client flips the question to *"what's the best interface for this
feature?"* — a completely different, and correct, question.

## Principles

- **Not a chat clone — a workspace.** Conversation is one tool among many. The
  client is the router's **control surface**, not another ChatGPT window.
- **The router becomes visible.** Instead of hiding routing, show it — role,
  model, fallback, tools, latency. Transparency builds trust; the router stops
  being magic and becomes understandable.
- **Logic stays in the router.** SpagDesk is a thin, first-class consumer of
  `/v1` + `/api/*`. No routing intelligence in the client — the same rule that
  governs every client (see client-strategy). A native client just gets *native
  homes* for router features, not new logic.
- **OWUI stays in parallel.** SpagDesk earns the switch by being better; we don't
  force a cutover. Every other OpenAI-compatible client keeps working via `/v1`.
- **Build once, incrementally.** MVP-first. Ship the bare necessity; grow as the
  need appears.

## Architecture

```
                LLMSpaghetti Router (/v1 + /api/*)
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   SpagDesk          VS Code           API clients
   (flagship)        extension         (OpenAI-compatible)
```

- SpagDesk talks to the router's **`/v1`** (chat) and **`/api/*`** (management:
  `routing-log`, `correction(s)`, `provider-health`, `quota-status`,
  `mcp-status`, `routing-mode`).
- Served by **Caddy** on its own route; OWUI kept on a parallel route so both run
  side by side.
- **Start buildless.** Phase 0 is a single static HTML/JS file — **no
  npm/webpack**. Instant iteration, no build step to fight (the lesson from the
  Cockpit plugin's build-and-deploy loop). Adopt a build + component framework
  (React) only when workspace complexity earns it.

## MVP-first roadmap

### Phase 0 — the terminal window (bare necessity)

A single static page. Prompt in → streamed response out through `/v1`. Nothing
else. Proves the client talks to the router and renders a reply. Served by Caddy.

### Phase 1 — make the router visible + reuse the loops we already built

- **Router Insight** — read the `x_llmspaghetti` field on each reply and show
  role / model / fallback. *This is the one thing OWUI fundamentally can't do,
  and the centerpiece of the whole idea.*
- **Inline correction** — 👍 / ✎-fix on a reply → `POST /api/correction` (the
  endpoint already built and proven on hardware). Corrections move from the
  Cockpit panel into the chat where they belong.
- **`intent: utility`** — SpagDesk marks its own housekeeping calls, so the
  `### Task:` shim retires for this client.
- Streaming, client-side conversation history.

### Phase 2 — the workspace shell

- **Left:** conversations · projects · files · saved prompts · history
- **Center:** the conversation
- **Right:** provenance · routing decisions · active tools · attached docs
- **Bottom:** prompt input · drag-and-drop files · quick actions

### Phase 3+ — bigger than chat

Compare responses side by side · generated-image browser · MCP activity timeline
· provider statistics · prompt templates · pinned outputs · Auto/Single toggle ·
workflows.

## Non-goals

- Not replacing OWUI on day one — they run in parallel until SpagDesk earns it.
- Not a ChatGPT clone.
- No routing logic in the client — it stays in the router.

## Open questions

- **Auth.** `/v1` + `/api/*` are internal today (no master key). How does SpagDesk
  authenticate — same-origin behind Caddy, or a token? What about remote access?
- **Buildless → React trigger.** What complexity threshold flips us to a build
  step and components?
- **Placement & coexistence.** Which route is SpagDesk on, which is OWUI, and
  which is the default landing page?
- **Persistence.** Conversations/projects: client-side (`localStorage`) first, or
  a backend store from the start?
