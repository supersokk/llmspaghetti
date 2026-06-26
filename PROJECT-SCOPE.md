# 🍝 LLMSpaghetti — Project Scope

> This document exists to give contributors, collaborators, and interested
> people a full picture of what LLMSpaghetti is, where it's going, and
> where we need help. Read it, think about it, tell us what's wrong with it.

---

## What is LLMSpaghetti?

LLMSpaghetti is a self-hosted AI control plane that turns any spare PC into
a unified AI gateway. It installs like an OS, manages itself like an appliance,
and feels like infrastructure rather than a weekend project.

The tagline says it best:

> **A tangled mess of AI routing that somehow works.**

It is a hobby project. The code is vibecoded spaghetti. There is no roadmap,
no SLA, no support contract. It exists because someone wanted it to exist and
built it. You are welcome to use it, break it, fix it, and make it better.

Full disclaimer: [DISCLAIMER.md](DISCLAIMER.md)

---

## The problem it solves

Most people who use AI seriously end up with the same mess:

- Claude in one browser tab
- ChatGPT in another
- Groq in a third
- A local model running somewhere
- Four different API keys in four different tools
- Manually switching between them depending on the task
- Paying for subscriptions that duplicate each other
- Sending everything to the cloud whether it needs to go there or not

LLMSpaghetti collapses all of that into one endpoint, one chat window,
and one place to manage everything. The routing happens automatically
based on what you're asking for. You stop thinking about which AI to use
and just work.

---

## The two killer use cases

### Use case 1 — The old laptop in your closet

You don't need a GPU. You don't need a powerful machine.

Install LLMSpaghetti on any old x86 laptop or desktop from the last decade.
Add your API keys for Claude, ChatGPT, and Groq. Now every device on your
network — phone, tablet, work laptop — has access to every AI subscription
you pay for through one URL, one chat window, one API key.

No new subscriptions. No GPU. Just a laptop and a router.

### Use case 2 — The "holy shit" moment

You're in one chat window. You type:

> "Can you generate an image of a cyberpunk city at night"

LLMSpaghetti detects: image request → routes to DALL-E → image appears in chat.

You type:

> "Now help me write the React component to display that image"

Routes to Claude → code comes back → same window.

You type:

> "Quick, what's the capital of Norway?"

Routes to Groq → answer in 200ms → same window.

You never switched tabs. You never thought about which AI to use.
It just went to the right one.

---

## How it works — the architecture

```
Your devices (VS Code, browser, phone, any tool)
        ↓
http://your-llmspaghetti-server/api/v1
One URL. One API key. Never changes.
        ↓
┌─────────────────────────────────────────────────────┐
│  LLMSpaghetti Control Plane                         │
│                                                     │
│  Caddy → LiteLLM Router → Intent Detection          │
│                         → Role Matching             │
│                         → Health Monitoring         │
│                         → Quota Management          │
│                         → Fallback Chains           │
└─────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
   Cloud APIs           Local Models          Services
   Claude               Llama 3               ComfyUI
   ChatGPT              Mistral               Whisper
   Groq                 CodeLlama             SearXNG
   DALL-E               DeepSeek R1           Qdrant
   Any API              Phi-3 Mini            n8n
```

The user talks to one thing. LLMSpaghetti figures out the rest.

---

## Core concepts

### Model roles

Every loaded model gets assigned a role. The router matches incoming
requests to the right role automatically.

| Role | What triggers it | Example models |
|---|---|---|
| `reasoning` | "think through", "plan", "why does" | DeepSeek R1, o1 |
| `code` | code files in context, "debug", "refactor" | Claude, CodeLlama |
| `fast` | short messages, "quick", "tldr" | Groq, Phi-3 |
| `image` | "generate image", "draw", "picture of" | DALL-E, ComfyUI |
| `document` | "summarise", long context, file uploads | Qwen, long-ctx models |
| `general` | everything else, catch-all | Llama 3 |
| `none` | excluded from auto-routing, direct calls only | any |

Multiple roles per model. Multiple models per role.
The router picks the best available one.

### Routing modes

**Auto mode** — LLMSpaghetti decides. Every message routed to the
best model for the job. User never thinks about it.

**Single mode** — User picks one model. That model handles everything
regardless of roles. Full control when you want it.

Switch modes mid-conversation. Mode persists per user.

### Background jobs

Long tasks (write documentation, process a file, generate a report)
can be sent to a background model while you keep working in the
foreground. Job completes, files appear, notification arrives.
You never stopped working.

### Node awareness

Single node today. Multi-node tomorrow. Every model entry carries
a node_id from day one so adding more machines is extending,
not rewriting. An old PC with no GPU becomes a CPU inference node.
A machine with a big spinning disk becomes a model storage node.
All routing through the same endpoint.

---

## The full feature set — current and planned

### ✅ Built

- Bootable ISO — flash to USB, installs itself, no questions asked
- Auto-detection of NVIDIA (CUDA) and AMD (ROCm) GPUs
- Silent installer — machine reboots into LLMSpaghetti, no Linux knowledge needed
- tty1 console status display — IP address and service health on the monitor
- First-boot web wizard — 4 steps, done in 2 minutes
- Docker Compose stack — Open WebUI + LiteLLM
- Ollama for local model management
- Caddy reverse proxy with WebSocket support
- Cockpit for server management (storage, network, services)
- ttyd embedded web terminal (browser-based shell)
- Live dashboard — CPU, RAM, per-GPU VRAM/temp/power/util, network, disk
- `spag` CLI — status, pull, models, config, key, doctor, logs, update, gpu
- Watchdog service — auto-restarts failed services
- Power controls — stop models, stop services, reboot, shutdown
- Pre-build validation suite (84 checks)
- Full test suite — local and remote SSH
- GPL v3 license
- GitHub-ready structure — CI, issue templates, CONTRIBUTING

### 🔥 Phase 1 — Core routing in Open WebUI (building now)

The product doesn't exist until this works. Everything else is secondary.

- Routing middleware between Open WebUI and LiteLLM
- Intent detection from message content
- Role-based model selection — silent, automatic
- Image requests → DALL-E or ComfyUI → inline in chat
- Auto mode and Single mode toggle
- "Answered by X (role)" indicator under each response
- Testing: "picture of a dog in a cradle" → image appears, no setup needed

### 🎛 Phase 2 — Control plane UI

- Visual routing rule editor — keyword, file type, token count rules
- Model roles config panel — tag UI, not YAML
- Provider health monitoring — live latency, auto-deprioritise degraded providers
- Fallback chains — primary → fallback → fallback
- Quota management — per-provider spend and request limits
- VRAM-aware model recommendations

### 🗂 Phase 3 — Models tab

- Load / Stop / Eject / Delete per model
- Per-model config panel — system prompt, temperature, context length, GPU layers
- Modelfile snapshot → Restore defaults
- VRAM budget bar — live
- Runtime selector per model (Ollama / llama.cpp / vLLM)

### 🖥 Phase 4 — Terminal + Updates

- Terminal welcome screen — guided menu for non-technical users
- Falls through to normal bash — not a cage
- Full update system — apt, GPU drivers, Ollama, Docker images, scripts from git
- `spag update` handles everything

### 🔌 Phase 5 — Services tap-to-install

One click to install, one click to remove. Each service is a Docker
Compose snippet + a UI card.

**Image generation:**
- ComfyUI — local Stable Diffusion, GPU accelerated
- Automatic1111 — alternative SD web UI

**Data and search:**
- SearXNG — self-hosted web search (feeds RAG)
- Qdrant — vector database for RAG pipelines
- Whisper — local speech-to-text

**Automation:**
- n8n — workflow automation, connects LLMs to everything
- Flowise — visual LLM chain builder

**MCP Tools (submenu):**

Default (always installed):
- filesystem — model reads/writes local files
- memory — persistent memory across conversations
- fetch — model reads URLs

Tap to install:
- Brave Search — web search (free tier available)
- GitHub — read/write repos
- PostgreSQL — query databases
- SQLite — query local .db files
- Puppeteer — browser control
- Docker — manage containers
- Obsidian — read notes vault

Per-role tool configuration:
- Every role has a default tool set
- User can tick/untick tools per role freely
- Warning shown when adding heavy tools to fast role
- Network tools vs local tools clearly labelled

### ⚙️ Phase 6 — Optional runtimes

- llama.cpp server — more control, lower overhead
- vLLM — production throughput on NVIDIA

### ⏳ Phase 7 — Async background jobs

- Long tasks run in background while you keep working
- Job queue with progress indicators
- Files written to workspace, served via HTTP
- Notification when complete
- Job chaining — multiple models, multiple tasks, one pipeline
- Triggered automatically by intent detection or explicitly by user

### 🌐 Phase 8 — Multi-node

Single node today. Structure baked in from day one so this is
extension not rewrite.

- Worker node join script — one command, node registers itself
- Node discovery — mDNS auto-detect on local network, manual fallback
- Nodes panel in web UI — live status, VRAM, loaded models per node
- Cross-node routing — roles span nodes, load balance automatically
- Failover — if a node goes offline, routing continues on remaining nodes
- CPU inference node — old hardware handles light tasks and overflow

Storage node deferred — revisit if community requests it.

### 💻 Phase 9 — VS Code extension

Only after Open WebUI routing works perfectly.

The extension is a thin connector — not a feature.
Anyone using Cline, Cursor, Continue already knows how to paste a URL.
The extension adds one thing paste-URL doesn't give you:

- Native background jobs panel in VS Code sidebar
- Live job status while you code
- File output drops directly into your workspace
- Notification when background job completes
- That's it. Everything else happens on the server.

Publish to VS Code marketplace.

### 🖥 Phase 10 — Native LLMSpaghetti chat window

Open WebUI gets us to launch. Our own chat window is where we end up.

A React app served at `http://your-server/chat` that is built
specifically for LLMSpaghetti — not a general chat UI that we've
configured to work with our stack.

Native features from day one:
- 🔀 Auto / 📌 Single mode toggle — prominent, always visible
- "↳ answered by X (role)" under every response
- Background jobs panel — sidebar, live progress
- File output viewer — background job results in chat
- Reasoning trace toggle — show/hide model thinking steps
- MCP tools active indicator — what tools are available right now
- Token usage per response
- Notifications — job complete, model offline, quota warning
- Pin a model mid-conversation

Shared component library with Cockpit plugin and VS Code extension.
Same design system everywhere.

Transition plan:
- First boot wizard initially points to Open WebUI
- When native chat is ready it becomes the default
- Open WebUI stays available at /webui — not removed, just not the front page

### The community router model (long term possibility)

As the fixture corpus grows, there may eventually be enough labelled
data to fine-tune a small open source model specifically for the
LLMSpaghetti routing task. A purpose-built 1B parameter router model
would be faster and more accurate than a general model doing
classification as a side task.

This is not something the core team needs to do — it's something
the community might do when the data earns it. The eval harness
already provides the benchmark it would need to beat.

Full design: [docs/PLANNED-router-model.md](docs/PLANNED-router-model.md)

---

## ⏸ Deliberately deferred

### Private role

We discussed building a "private" role that guarantees data never
leaves the machine. We paused it.

The problem: "private" implies a security guarantee. We can control
the routing layer. We cannot fully control what MCP tools do, what
executed code does, what logs capture. A wrong privacy guarantee
is worse than no privacy guarantee.

Current thinking: rename to "local" (honest routing promise only)
and defer anything that implies data security to when we have
someone who thinks in threat models, not features.

Full thinking captured in: [docs/PLANNED-private-role.md](docs/PLANNED-private-role.md)

Community input very welcome on this one.

### Storage node

Each node stores its own models. Sharing model files across nodes
via NFS or similar adds complexity and a single point of failure
for a problem that only exists at scale. Deferred until someone
actually needs it and opens an issue.

---

## What we need help with

### Testing on real hardware

We need compatibility reports. Does it work on your GPU?
Your old laptop? Your weird server hardware?

Open an issue with the `hardware-report` label.
Even "tested on X, works fine" is valuable.

### The private/local role design

This needs someone who thinks about security properly.
What should the threat model be? What can we honestly guarantee?
What should we call it? See [docs/PLANNED-private-role.md](docs/PLANNED-private-role.md).

### AMD ROCm testing

NVIDIA CUDA is well tested. AMD ROCm is less so.
If you have AMD hardware, please test and report.

### The routing middleware (Phase 1)

The most important thing to get right. Intent detection that
correctly identifies image requests, reasoning requests, code
requests from natural language. False positives (routing to
the wrong model) are worse than no routing. How do we get
this right without being too aggressive?

### Multi-node architecture

The structure is baked in but the implementation is unbuilt.
If you've built distributed systems before, the design questions
here are interesting. How should node discovery work? What
happens during split-brain? How do we handle partial node
failures gracefully?

### The native chat window (Phase 10)

React developers who want to build a chat UI from scratch
with a clear design spec. This is the most UI-heavy piece
of the whole project.

### Documentation and translations

The install guide needs to work for someone who has never
touched Linux. If you find anything confusing, that's a bug.
Translations welcome — LLMSpaghetti should work for people
who don't read English fluently.

---

## Technical stack

| Layer | Technology | Why |
|---|---|---|
| Base OS | Ubuntu Server 22.04/24.04 | Best driver support, widest compatibility |
| GPU (NVIDIA) | CUDA via official .deb repo | Standard, well supported |
| GPU (AMD) | ROCm via AMD apt repo | Best available for AMD |
| Model runner | Ollama | Clean API, good model support, active development |
| API gateway | LiteLLM | Supports 100+ providers, fallbacks, load balancing |
| Chat UI (now) | Open WebUI | Best available, active community |
| Chat UI (future) | React (our own) | Full control, native features |
| Reverse proxy | Caddy | Auto HTTPS, clean config, WebSocket support |
| Server management | Cockpit + plugin | Production quality, extensible |
| Web terminal | ttyd | Lightweight, xterm.js, works everywhere |
| Management UI | React (Cockpit plugin) | Same stack as future chat window |
| CLI | bash (`spag`) | No dependencies, works everywhere |
| Services | Docker Compose | Isolation, easy updates, standard |
| Installer | Subiquity autoinstall | Ubuntu's own silent installer |
| ISO build | xorriso + squashfs | Standard Linux ISO toolchain |
| Tests | bash + Python | No framework overhead |
| CI | GitHub Actions | Free, integrated, runs on every PR |

---

## Design principles

**Appliance not server** — it installs itself, manages itself, recovers
itself. The user should never need to SSH in to keep it running.

**Browser not terminal** — everything manageable from a browser.
The terminal is there for power users, not a requirement for normal use.

**Honest not impressive** — we don't make claims we can't back up.
"Routes to a local model" is honest. "Keeps your data private" is not
something we can fully guarantee, so we don't say it.

**Extend not replace** — Open WebUI, Ollama, LiteLLM, Cockpit are
good projects. We use them. We build around them. We replace them only
when we've outgrown them (see Phase 10 — native chat window).

**Lean not bloated** — default install is minimal. Everything optional
is tap-to-install. Nobody gets ComfyUI if they don't want ComfyUI.

**Node-aware from day one** — every config entry carries a node_id.
Multi-node is an extension not a rewrite.

---

## What LLMSpaghetti is not

- Not a security product. Don't use it for data that could get you sued.
- Not a managed service. Nobody is monitoring it for you.
- Not regularly updated. Updates happen when contributors contribute.
- Not tested on every hardware configuration. It works on what it's been tested on.
- Not competing with Ollama, Open WebUI, or LiteLLM. It uses all of them.
- Not an enterprise product. It's a hobby project with good bones.

---

## How to get involved

**Use it and report back** — hardware compatibility, bugs, confusing docs.
Every report makes it better.

**Pick something from the TODO** — [TODO.md](TODO.md) is prioritised.
Phase 1 is the most important. Everything in Phase 1 is buildable right now.

**Think about hard problems** — the private role design, the routing
accuracy problem, the multi-node split-brain question. These need
people who think carefully, not just people who write code fast.

**Write docs** — the install guide needs to work for someone who has
never used Linux. If you find anything unclear, fix it and PR it.

**Test on weird hardware** — old laptops, AMD GPUs, unusual configs.
The more hardware reports we have, the better the compatibility story.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## Current status

Alpha. It installs. The base stack runs. The dashboard shows live stats.
The `spag` CLI works. The test suite passes.

What doesn't exist yet: the routing layer (Phase 1). Without that,
LLMSpaghetti is a well-packaged Ollama + Open WebUI installer.
With it, it's the thing described in this document.

Phase 1 is what we build next.

---

*Yes, it's spaghetti. Yes, it works. Somehow.* 🍝

---

**Links:**
- [TODO.md](TODO.md) — full prioritised task list
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute
- [DISCLAIMER.md](DISCLAIMER.md) — honest project disclaimer
- [docs/PLANNED-private-role.md](docs/PLANNED-private-role.md) — deferred feature design
- [docs/architecture.svg](docs/architecture.svg) — system architecture diagram
