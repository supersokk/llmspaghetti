# Technical Overview

How LLMSpaghetti works under the hood — for contributors and anyone who wants a
deeper understanding than the [README](../README.md). For the vision and
philosophy, see [PROJECT-SCOPE.md](../PROJECT-SCOPE.md); to install, see
[install.md](install.md).

---

## The core idea

LLMSpaghetti exposes **one OpenAI-compatible endpoint** (`/v1`). Every request
flows through a **router** that reads the message, classifies its intent, and
silently rewrites which model handles it. The client only ever talks to one URL.

```
Your IDE / Chat / CLI
        ↓
http://your-server/v1        ← one URL, never changes
        ↓
  Router (:5000)             ← THE product: classify → pick model → forward
        ↓
  LiteLLM (:4000)            ← OpenAI-compatible gateway to every provider
        ↓
  Ollama (local)  ·  cloud APIs (OpenAI / Anthropic / Groq / …)
```

**All intelligence lives in the router, behind the endpoint.** Clients
(Open WebUI today, VS Code next, a custom chat later) are thin, swappable
consumers. See [PLANNED-client-strategy.md](PLANNED-client-strategy.md).

---

## Request flow

For each `POST /v1/chat/completions` the router:

1. Extracts the latest message and context (attachments, code blocks, length).
2. **Classifies** it into a role (see below).
3. Maps the role → a model via `config/router_roles.yaml`.
4. **Rewrites `payload["model"]`** to that model — the whole trick.
5. Applies quota checks (with fallback), image-role short-circuit (DALL-E),
   and MCP tool injection if the role has installed tools.
6. Strips any client-supplied `tools`/`tool_choice` — the router owns tool
   management, clients don't get to inject tools.
7. Forwards to LiteLLM, streams the response back (re-wrapping as SSE when a
   tool-call loop had to run non-streaming).
8. **Tags the reply with provenance** — which model actually answered (see below).

The classifier ([eval/classifier.py](../eval/classifier.py)) is a tiered,
keyword+signal design (no LLM call on the hot path):

```
signal      attachments, code blocks, token count     ~0ms
keyword     collision-guarded trigger words           ~0ms
(future)    kNN over local corrections + community    ~ms   ← see flywheel doc
(future)    LLM tier for genuine ambiguity            ~100ms
fallback    nothing matched → general                 —
```

---

## Roles

Every model is assigned a role; the router matches each message to one.

| Role | Triggers | Typical model |
|---|---|---|
| `reasoning` | "think through", "plan", "why does" | DeepSeek R1, o1 |
| `code` | code in context, "write a function", "debug" | Claude, Qwen-Coder |
| `fast` | short messages, "quick", "what is X" | Groq, small local |
| `image` | "generate image", "draw", "picture of" | DALL-E, ComfyUI |
| `document` | "summarise", long context, file uploads | large-context model |
| `general` | everything else (catch-all) | default local model |
| `none` | excluded from auto-routing (direct calls only) | any |

Multiple roles can point at one model; a role with no available model falls
back to the default. Mapping lives in `config/router_roles.yaml`.

## Routing modes

- **Auto** (default) — classify every message, route to the best model.
- **Single** — bypass classification, send everything to one chosen model
  (`mode: single` + `single_model` in `router_roles.yaml`).

The auto/single **UI switcher** in the chat is not built yet (a TODO item);
the backend supports both modes today.

## Provenance — "show your work"

Routing is silent, but never hidden. Every routed reply is tagged with the model
that actually answered, in two forms:

- **A visible footer** appended to the reply text —
  `` `↳ LLMSpaghetti → qwen2.5-coder:3b · code` `` — so it shows in any client
  (Open WebUI, VS Code, curl) and survives copy-paste. No per-client plugin.
  The model name is resolved from its LiteLLM alias (e.g. `local-default` →
  `qwen2:0.5b`) so it names the real model, not the internal alias.
- **A machine-readable field** on the response body, `x_llmspaghetti`, so tools
  can parse the decision programmatically:

```json
{ "router": "llmspaghetti", "model": "qwen2.5-coder:3b",
  "role": "code", "fallback": false }
```

It is **fallback-aware**: if the primary model fails and the router retries a
fallback, the tag names the model that *actually* answered and sets
`"fallback": true`. Both the streaming and non-streaming paths are covered — in
streaming, the footer is injected as a final SSE chunk just before `[DONE]`.

Toggle with `show_provenance` in `config/router_roles.yaml` (default `true`).
Leaving it on is the "nothing hidden" default; turning it off is a deliberate choice.

## MCP tools

Roles can be granted MCP tools (`config/role_tools.yaml`), which the router
injects as OpenAI function schemas and resolves via subprocess MCP servers.
A tool must be installed (Services → MCP Tools, recorded in `config/mcp.json`)
before it's offered — an empty `mcp.json` means no tools are injected.
See [PLANNED-model-management.md](PLANNED-model-management.md) for the open
questions around making pulled models and tools routable.

---

## Components

| Component | Role |
|---|---|
| [Ollama](https://ollama.com) | Runs local models |
| [Open WebUI](https://github.com/open-webui/open-webui) | Chat UI (current client) |
| [LiteLLM](https://litellm.ai) | OpenAI-compatible gateway to 100+ providers |
| **Router** (in-house) | Classifies + routes — the product |
| [Cockpit](https://cockpit-project.org) | Server management web UI (:9090) |
| [ttyd](https://github.com/tsl0922/ttyd) | Browser terminal |
| [Caddy](https://caddyserver.com) | Reverse proxy, optional HTTPS |
| Ubuntu Server | Base OS |

We **orchestrate** Ollama / LiteLLM / Open WebUI — we don't reinvent them. The
in-house code is the routing brain and the appliance glue.

**Routing enforced:** Open WebUI's native Ollama API is disabled
(`ENABLE_OLLAMA_API=false`) so every message must pass through the router — a
user can't pick a raw model and bypass routing.

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Base OS | Ubuntu Server 22.04 / 24.04 / 26.04 | Best driver support |
| GPU (NVIDIA) | driver via `ubuntu-drivers` | prebuilt, kernel-matched (Ollama bundles CUDA) |
| GPU (AMD) | ROCm | best available for AMD |
| Model runner | Ollama | clean API, active dev |
| API gateway | LiteLLM | 100+ providers, fallbacks |
| Chat UI | Open WebUI (→ own client later) | best available today |
| Reverse proxy | Caddy | auto-HTTPS, WebSocket |
| Management | Cockpit + React plugin | production-grade, extensible |
| Router / wizard | Python (FastAPI) | simple, no ORM |
| CLI | bash (`spag`) | no deps |
| Services | Docker Compose | isolation, easy updates |
| Installer | Subiquity autoinstall (planned) | Ubuntu's own silent installer |

---

## Project structure

```
llmspaghetti/
├── router/          FastAPI router — classify + route (the product)
├── eval/            classifier.py + eval harness + fixtures
├── firstboot/       FastAPI first-boot setup wizard + templates
├── console/         status.py — tty1 live status dashboard
├── cockpit-plugin/  React management UI (Dashboard, Models, Routing, Services…)
├── scripts/         bootstrap.sh, gpu-detect, gpu-drivers, spag CLI, watchdog
├── services/        systemd units (router stack, status, firstboot, watchdog)
├── stack/           docker-compose.yml + Caddyfile
├── config/          router_roles.yaml, role_tools.yaml, quotas.yaml, mcp.json
├── iso/             ISO builder + autoinstall (planned)
├── test/            pre-build checks + test suite
└── docs/            this documentation
```

---

## Config files

| File | Purpose |
|---|---|
| `config/router_roles.yaml` | role → model mapping, routing mode |
| `config/role_tools.yaml` | which MCP tools each role gets |
| `config/mcp.json` | installed MCP servers |
| `config/quotas.yaml` | per-provider request/spend limits |
| `config/litellm_config.yaml` | LiteLLM model list (generated by the wizard) |
| `config/api_keys.env` | cloud provider keys (git-ignored) |

Most are hot-reloaded (mtime-watched); the router picks up edits without a restart.

---

## Related design docs

Deeper, forward-looking designs live in `PLANNED-*.md` — see the
[docs index](README.md).
