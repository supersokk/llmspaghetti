# Project Scope

The vision: what LLMSpaghetti is for, who it's for, and the principles that
guide it. For how it works, see [docs/technical.md](docs/technical.md); to
install, see [docs/install.md](docs/install.md).

---

## What it is

A self-hosted **AI router** that turns a spare PC into one endpoint in front of
every model you have — local and cloud. You talk to one chat window; the router
reads each message and silently sends it to the right model. It installs like an
appliance and is meant to feel like infrastructure, not a weekend script.

> A tangled mess of AI routing that somehow works.

It's a hobby project, community-maintained, GPL v3. See [DISCLAIMER.md](DISCLAIMER.md).

---

## The problem it solves

People using AI seriously end up with the same mess: Claude in one tab, ChatGPT
in another, Groq in a third, a local model somewhere, four API keys in four
tools, manually switching per task, and sending everything to the cloud whether
it needs to go there or not. LLMSpaghetti collapses that into one endpoint, one
chat, one place to manage everything — that **you** own.

---

## Who it's for

- **Homelabbers with a GPU** (primary) — run several local models, give each a
  role, keep everything on your own hardware.
- **People with cloud subscriptions and no GPU** (secondary) — route your
  existing Claude/ChatGPT/Groq access through one endpoint for every device.
- **Anyone using OpenAI-compatible tools** (Cursor, Continue, Aider, scripts) —
  point them at one URL that never changes.

Not for: production/enterprise use, anything where downtime costs money, or
anyone needing a support contract.

---

## The two killer use cases

**1 — The homelab box (the point).** A machine with a GPU, several local models,
each assigned a job: coder → code, reasoning → "think this through", document →
long files. One chat window routes between them automatically. Nothing leaves
your network unless you add a cloud key.

**2 — The old laptop.** No GPU. Add your cloud API keys and it becomes a pure
router — every AI you subscribe to, through one URL, for every device in the
house. The laptop does no inference; it just routes.

---

## Goals

- One endpoint, one chat, automatic routing to the right model.
- Local-first: your models on your hardware by default; cloud is opt-in.
- Installs and manages itself like an appliance; browser-first, not terminal-first.
- Transparent: every answer shows which model handled it.
- Extends the ecosystem (Ollama, LiteLLM, Open WebUI) rather than replacing it.

## Non-goals

- Not a security/privacy product — we make routing promises, not data-protection
  guarantees (see [docs/PLANNED-private-role.md](docs/PLANNED-private-role.md)).
- Not a managed service, not production-grade, not on a release schedule.
- Not a reimplementation of Ollama / LiteLLM / Open WebUI.
- Not (yet) multi-node — the structure is node-aware, the implementation is future.

---

## Design principles

**Nothing hidden — show your work.** Most routing layers are black boxes; ours
isn't. Every answer says which model responded, fallbacks are visible (never
silent), the routing log is inspectable, and the code is GPL. A silent failure
is a hidden failure — the one thing we don't ship.

**Use what we have, but smarter.** Orchestrate Ollama, LiteLLM, and Open WebUI;
never reinvent them. We own the *routing brain*, not the commodities.

**One smart endpoint, thin clients.** All intelligence lives in the router,
behind a single `/v1` endpoint. Clients (Open WebUI now, VS Code next, our own
chat as the end-game) are thin and swappable. Logic goes in the router, never in
client-specific glue. See [docs/PLANNED-client-strategy.md](docs/PLANNED-client-strategy.md).

**Honest not impressive.** We don't claim what we can't back up. "Routes to a
local model" is honest; "keeps your data private" is not something we can fully
guarantee, so we don't say it.

**Appliance, not server.** It installs, manages, and recovers itself. You
shouldn't need to SSH in to keep it running.

**Lean, not bloated.** Minimal default install; everything optional is
tap-to-install. Node-aware from day one so multi-node is an extension, not a rewrite.

---

## Long-term direction

Rough roadmap (details and status in [TODO.md](TODO.md)):

1. **Core routing** (working) — silent, enforced, multi-model.
2. **Control plane** — visual routing rules, provider health, quotas, fallbacks.
3. **Models & services** — model management UI, tap-to-install services, MCP tools.
4. **Own client** (end-game) — a purpose-built chat that unlocks what Open WebUI
   can't host (background jobs, rich provenance), viable *because* the backend
   already does the work.
5. **Multi-node** — join workers, route across machines.

The end-game is owning the full experience while the router stays the product.

---

## What needs the most thought

Some things are deliberately unbuilt until designed properly — captured as
`PLANNED-*` docs (see the [docs index](docs/README.md)): the "private/local"
role, the community-trained router model, the routing-correction flywheel, and
background jobs. Contributions and hard thinking welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

*Yes, it's spaghetti. Yes, it works. Somehow.* 🍝
