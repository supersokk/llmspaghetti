# 🍝 LLMSpaghetti — TODO

> Living document. Updated as we build.
> PRs that tick things off are very welcome.

---

## 🔥 PHASE 1 — Core routing in Open WebUI (THIS IS THE PRODUCT)

Everything must work here first. User opens Open WebUI, talks naturally,
gets the right answer from the right model. They never think about routing.

### Intent detection + silent routing
- [ ] Routing middleware sits between Open WebUI and LiteLLM
- [ ] Reads every incoming message
- [ ] Detects intent from message content
- [ ] Selects correct model role silently
- [ ] User never sees the mechanics — just gets the right answer

### Roles (the heart of it)
- [ ] `reasoning`  — "think through", "plan", "architect", "why does"
                     → DeepSeek R1 or similar thinking model
- [ ] `code`       — code files in context, "write", "debug", "refactor"
                     → Claude / CodeLlama
- [ ] `fast`       — short messages, "quick", "tldr", "what is X"
                     → Groq
- [ ] `image`      — "generate image", "draw", "picture of", "create image"
                     → DALL-E or local ComfyUI
                     → image appears inline in Open WebUI chat
- [ ] `private`    — ⏸ PLANNED. Needs serious design thinking before building.
                     See PLANNED-private-role.md. Do not implement until thought through.
- [ ] `document`   — "summarise", "read this", long context requests
                     → model with large context window
- [ ] `general`    — everything else, catch-all fallback
                     → default local model
- [ ] `none`       — model is running but router never touches it
                     → direct calls only, excluded from auto-routing 🚫

### Image routing (the killer feature)
- [ ] Detect image requests in routing middleware
- [ ] Route to DALL-E (if OpenAI key present) or ComfyUI (if installed)
- [ ] Image saved to server at /opt/llmspaghetti/images/
- [ ] Served via HTTP at http://your-server/images/filename.png
- [ ] URL returned to Open WebUI → renders inline as image
- [ ] Works completely silently — user just sees the image appear

### Multi-model simultaneously
- [ ] Multiple models loaded in VRAM at once
- [ ] Each assigned a role
- [ ] Router picks the right one per message
- [ ] User sees one seamless conversation
- [ ] VRAM budget tracked so you know what fits

### Testing Phase 1
- [ ] "I need a picture of a dog in a cradle" → image appears
- [ ] "Think through this architecture" → reasoning model responds
- [ ] "Quick, what is the capital of Norway?" → Groq responds fast
- [ ] "Here is my confidential document..." → local model only, no cloud
- [ ] "Debug this Python function" → code model responds
- [ ] All of the above in ONE Open WebUI chat session

---

## 🎛 PHASE 2 — Control plane UI

Once routing works, give users control over it.

- [ ] Visual routing rule editor in web UI
      - Keyword rules, drag to reorder priority
      - Private flag with hard no-cloud indicator 🔒
      - Per-route logging (see what went where)
- [ ] Model roles config panel
      - Assign roles to models via tag UI, not YAML
      - Multiple roles per model supported
- [ ] Provider health monitoring
      - Live latency per provider
      - Auto-deprioritise slow/down providers
      - Health panel in Dashboard
- [ ] Fallback chains
      - Primary → fallback → fallback
      - Private role: no fallback, fail loudly
- [ ] Quota management
      - Per-provider request/spend limits
      - Warn at 80%, block at 100%

---

## 🗂 PHASE 3 — Models tab

- [ ] Load / Stop / Eject / Delete buttons
- [ ] VRAM budget bar (live, updates as models load/unload)
- [ ] Per-model config panel
      - System prompt, temperature, Top-P, Top-K
      - Context length, repeat penalty
      - GPU layers, threads
- [ ] Modelfile snapshot → Restore defaults button
- [ ] Runtime selector (Ollama / llama.cpp / vLLM)

---

## 🖥 PHASE 4 — Terminal + Updates

- [ ] Terminal welcome screen / guided menu
      - Friendly TUI, not a blank shell
      - Numbered options, falls through to bash
      - "What did that do?" explanation after each action
- [ ] Full update system via `spag update`
      - apt upgrade, GPU drivers, Ollama, Docker images, scripts from git

---

## 🔌 PHASE 5 — Services tap-to-install

- [ ] ComfyUI    — local image generation (pairs with image routing)
- [ ] SearXNG    — self-hosted search for RAG
- [ ] Whisper    — local speech-to-text
- [ ] Qdrant     — vector database for RAG
- [ ] n8n        — workflow automation
- [ ] Flowise    — visual LLM chain builder
- [ ] Automatic1111 — alternative SD web UI

---

## 🏗 PHASE 6 — ISO + end-to-end testing

- [ ] Start from minimal Ubuntu Server (no extras, no snap, no cloud-init bloat)
      Goal: smallest possible base before bootstrap runs
      Strip: snapd, cloud-init, landscape-client, motd-news, apport, unattended-upgrades
- [ ] Minimum disk size requirement: document as 30GB (Docker images alone ~4GB, models vary)
- [ ] Full boot → wizard → routing test in QEMU
- [ ] "Dog in a cradle" image test from fresh install
- [ ] Router-only mode (old laptop, no GPU, cloud APIs only)
- [ ] AMD ROCm test
- [ ] CPU-only test
- [ ] Multi-GPU test

---

## ⚙️ PHASE 7 — Optional runtimes

- [ ] llama.cpp server as optional backend
- [ ] vLLM as optional backend (NVIDIA only)

---

## 🌐 PHASE 8 — Multi-node

Structure baked in from day one (node_id in all configs).
Full implementation after single node is rock solid.

- [ ] Worker node join script (one command)
- [ ] Node discovery (mDNS + manual fallback)
- [ ] Nodes panel in web UI
- [ ] Cross-node routing + load balancing
- [ ] Failover if node goes offline
- [ ] CPU inference node role
- [ ] Storage node — DEFERRED (revisit if community requests)

---

## 💻 PHASE 9 — VS Code extension

**Only after Open WebUI routing works perfectly.**

The extension is a thin connector. Nothing more.
Anyone using Cline, Continue, Cursor, Aider already knows
how to paste a URL — we don't need to document that.

- [ ] Simple VS Code extension
      - One field: your LLMSpaghetti server URL
      - Connects to the same routing layer
      - Same models, same roles, same routing
      - Different window, same product
- [ ] Publish to VS Code marketplace

**Deliberately NOT doing:**
- Custom slash commands in VS Code
- Claude Code integration
- Cline-specific docs
- Continue.dev config guides
- Any of that — paste the URL, it works, end of story

---

## 📝 PHASE 10 — Docs + polish

- [ ] Audit privacy claims in README + DISCLAIMER
- [ ] Hardware compatibility table
- [ ] Architecture diagram in README ✅ (done)
- [ ] IDE section: "Use any tool — paste the URL, done"

---

## ✅ Done (this session)

- [x] Runtimes in Services tab — llama.cpp server + vLLM (Docker, tap-to-install)
- [x] MCP Tools in Services tab — 7 servers (filesystem, memory, fetch, brave, github, sqlite, postgres), npm-based install, writes mcp.json
- [x] config/mcp.json + config/role_tools.yaml — new config files
- [x] Routing tab — "MCP Tools" view: per-role checkbox grid for tool assignment, reads/writes role_tools.yaml
- [x] Router — MCP tool injection (schemas → LiteLLM), tool-call resolution loop (up to 5 turns, MCP subprocess), re-stream after resolution
- [x] /api/mcp-status endpoint — configured servers + role assignments
- [x] VS Code extension — one URL field, status bar, setup guide webview, 5 commands, auto-ping every 60s
- [x] Settings tab — API key management (7 providers, masked inputs, writes api_keys.env, restarts LiteLLM), full system update (apt + Ollama + images), live update log
- [x] Router — _load_api_keys() hot-loads api_keys.env into os.environ at startup

## ✅ Done (previous sessions)

- [x] Project scaffold (58 files)
- [x] GPU detection (NVIDIA/AMD/auto)
- [x] GPU driver installer (CUDA + ROCm)
- [x] Bootstrap script
- [x] First-boot web wizard (FastAPI + Jinja2)
- [x] tty1 console status display
- [x] Docker Compose stack (Open WebUI + LiteLLM)
- [x] Caddy reverse proxy + WebSocket support
- [x] Cockpit server management
- [x] ttyd embedded web terminal
- [x] Dashboard tab (CPU/RAM/GPU/Network/Disk live stats)
- [x] `spag` CLI
- [x] Watchdog service
- [x] Power controls (stop models/services/reboot/shutdown)
- [x] Pre-build validation suite (84 checks)
- [x] Full test suite (local + remote SSH)
- [x] GPL v3 license
- [x] GitHub-ready structure (CI, issue templates, CONTRIBUTING)
- [x] Renamed to LLMSpaghetti 🍝
- [x] `spag` CLI alias
- [x] Chef robot logo
- [x] README rewritten around killer use cases
- [x] Architecture SVG diagram
- [x] Honest disclaimer
- [x] Node-aware structure baked in
- [x] TODO properly prioritised around Open WebUI first

---

## 🔧 MCP Tools (tap to install, submenu under Services)

### Default MCP servers (always installed, on by default)
- [ ] filesystem — model reads/writes local files
- [ ] memory    — persistent memory across conversations
- [ ] fetch     — model reads URLs

### Tap to install
- [ ] Brave Search  — web search (free tier: 2000/month)
- [ ] GitHub        — read/write repos
- [ ] PostgreSQL    — query databases
- [ ] SQLite        — query local .db files
- [ ] Puppeteer     — browser control / web agent
- [ ] Docker        — manage containers
- [ ] Obsidian      — read notes vault

### Per-role tool configuration
- [ ] Checkbox UI per role — tick which tools that role gets
- [ ] Default sets per role (sensible out of box):
      reasoning → memory, fetch
      code      → filesystem, memory, github
      fast      → none (speed is the point)
      private   → ⏸ PLANNED (see PLANNED-private-role.md)
      general   → memory, fetch
      document  → filesystem, memory
      image     → none
      none      → none
- [ ] User can override any default freely
- [ ] Warning shown when adding heavy tools to fast role
      "Tools added to a fast model may increase response times"
- [ ] [Reset to defaults] button per role
- [ ] Private role constraints — ⏸ PLANNED (see PLANNED-private-role.md)
- [ ] Tool-role awareness in routing
      - Active tools for the role passed to model with request
      - Model knows what it has available

### MCP management UI (submenu in Services tab)
- [ ] Services tab structure:
      ├── Runtimes          (llama.cpp, vLLM)
      ├── Image Generation  (ComfyUI, Automatic1111)
      ├── Data & Search     (SearXNG, Qdrant, Whisper)
      ├── Automation        (n8n, Flowise)
      └── MCP Tools         ← submenu
          ├── Installed (status dots, Config, Stop buttons)
          └── Available (Install buttons)
- [ ] Config per server (paths, API keys, permissions)
- [ ] Test button per server (ping the MCP server)
- [ ] Active tools shown in chat header in Open WebUI

---

## 🎛 Routing Mode — Auto vs Single

- [ ] Two routing modes selectable in Open WebUI header (always visible)

      AUTO mode (default)
        - LLMSpaghetti decides which model handles each message
        - Based on roles, intent detection, content
        - User never thinks about it
        - "I need a picture of a dog" → image role
        - "Think through this" → reasoning role
        - Indicator: 🔀 Auto

      SINGLE mode
        - User picks one specific model
        - That model handles ALL messages regardless of roles
        - Routing rules completely bypassed
        - User is in full control
        - Useful when you want to test a specific model
        - Useful when you know exactly what you need
        - Useful for long focused sessions with one model
        - Indicator: 📌 Llama 3 8B (or whatever is picked)

- [ ] Mode switcher in Open WebUI
        - Persistent toggle in the chat header
        - Auto → shows 🔀 Auto
        - Single → shows model picker dropdown
                   📌 [Llama 3 8B ▾]
        - Switching modes mid-conversation is allowed
        - Mode persists across browser refresh per user

- [ ] Single mode behaviour
        - Selected model gets every message
        - No intent detection runs
        - No role matching
        - MCP tools still active for that model
        - If selected model is offline → warn user, dont auto-switch silently
          "⚠️ Llama 3 8B is not loaded. Switch to Auto or load the model."

- [ ] Auto mode behaviour  
        - Full routing pipeline runs per message
        - Falls back to general role if no intent detected
        - If role model is offline → use fallback chain
        - User never sees routing mechanics

- [ ] Visual indicator in chat
        - Every message response shows which model answered
        - Small subtle tag under the response
        - Auto mode:   "↳ answered by Groq (fast role)"
        - Single mode: "↳ Llama 3 8B"
        - Can be toggled off in settings for clean UI

---

## 🧠 Community Router Model (long term, community-driven)

Not a core team task. Documented so the right contributor can find it.
Needs: ML skills + enough fixture data + someone willing to do it.

- [ ] Prerequisite: ~1,000 community fixtures accumulated
- [ ] Prerequisite: fixture quality review process working
- [ ] Prerequisite: held-out eval set separate from training data
- [ ] Fine-tune small model (Phi-3 Mini or Gemma 2B) on fixture corpus
      using LoRA/QLoRA via HuggingFace PEFT
- [ ] Measure against eval harness — must beat keyword classifier
- [ ] Publish weights on Hugging Face as llmspaghetti/router:v1
- [ ] Wire into LLMSpaghetti as optional classifier role
      ollama pull llmspaghetti/router:v1
- [ ] Version roadmap: v1 → v2 → lite → pro → multilingual

Full design: docs/PLANNED-router-model.md
Open questions: open as GitHub Discussions, not Issues
