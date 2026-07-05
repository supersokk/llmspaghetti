# 🍝 LLMSpaghetti — Changelog

All notable changes to LLMSpaghetti will be documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added (2026-07-05 — Local image generation via ComfyUI)

- **The `image` role now generates locally through ComfyUI**, self-hosted on the
  host beside Ollama — no cloud key, no per-image cost. The router queues a
  txt2img workflow to ComfyUI's API (`COMFYUI_URL/prompt`), polls `/history` for
  the PNG, copies it into `IMAGES_DIR`, and returns it as inline markdown — the
  same serve-by-URL path (`/images/*` via Caddy) DALL-E used. So "draw me a …"
  in the *same chat* returns an image without switching apps.
- **DALL-E stays as a cloud fallback** — if ComfyUI is disabled/unreachable and
  `OPENAI_API_KEY` is set, the router falls back to DALL-E, then to a text model.
- **Tunable via env** (`COMFYUI_URL`, `COMFYUI_ENABLED`, `COMFYUI_MODEL`,
  `COMFYUI_STEPS`, `COMFYUI_SIZE`, `COMFYUI_CFG`, `COMFYUI_NEGATIVE`,
  `COMFYUI_TIMEOUT`); defaults target an SD1.5 checkpoint (`dreamshaper_8`) at
  512×512, patient enough for a shared 8GB card that spills to RAM.
- Image replies now carry a provenance footer (`↳ LLMSpaghetti → dreamshaper_8 · image`).

### Changed (2026-07-03 — Ollama-direct routing + Cerebras)

- **Local models now route straight to Ollama, by their raw name.** The router
  forwards local Ollama models to Ollama's own OpenAI-compatible API
  (`OLLAMA_URL/v1`), skipping the LiteLLM alias layer; **cloud models still go
  through LiteLLM**. So any pulled model is assignable to any role by its real
  name (`qwen2.5:3b`, `freaky-coderzzzy:14b`) — no `model_name` alias, no
  wildcard, no "Invalid model name". `_route_backend()` picks the backend per
  model; the fallback is backend-aware; provider-health pings the right backend.
- **The Routing dropdown lists both** — LiteLLM aliases + cloud (`/v1/models`)
  *and* every installed Ollama model (raw). Pick either; both route.
- **Cerebras added as a cloud provider** — Settings API-key field
  (`CEREBRAS_API_KEY`) + firstboot litellm_config entries (`cerebras-llama-8b`,
  `cerebras-llama-70b`, free tier at cloud.cerebras.ai). Routes via LiteLLM like
  any cloud model.

### Added (2026-07-03 — SpagDesk: our own workspace client, MVP)

- **The router now has a native client.** SpagDesk is a buildless, static
  single-page workspace served by Caddy at `/desk/`, alongside Open WebUI (not
  replacing it). First step toward giving the router the interface it was
  designed to have — see docs/PLANNED-spagdesk.md.
- **MVP (Phase 0/1):** streamed chat through `/v1`; a native **Router Insight**
  panel (role / model / fallback, from the `x_llmspaghetti` field — the thing
  OWUI can't show); inline **✎ fix** corrections that call `/api/correction`
  (the flywheel loop moves into the chat).
- Router calls go through a `/spag/*` Caddy prefix, avoiding the clash with
  OWUI's own `/api/*`. No build step — a single `index.html`, so iteration is
  instant. Deployed by bootstrap.

### Fixed (2026-07-02 — Cockpit plugin never loaded)

- **The Cockpit plugin was broken end-to-end** (only surfaced when first opened
  on hardware — it showed "Not found"). Two packaging bugs:
  1. `install-plugin` ran `cp -r dist/`, which **nests** the bundle under
     `.../llmspaghetti/dist/` when the dir already exists — so `index.html`
     (which loads `llmspaghetti.js` from its own dir) kept serving a stale build.
     Now copies `dist/llmspaghetti.js` flat and clears the stale `dist/`.
  2. `manifest.json` menu keys were `llmspaghetti` / `llmspaghetti-main`, so
     Cockpit looked for `llmspaghetti.html` (nonexistent) → "Not found".
     Collapsed to a single `index` entry that loads the shipped `index.html`.
  3. Every tab reached the router via browser `fetch("http://localhost:5000")`
     — unreachable from a remote browser and CORS-blocked even locally, so the
     routing log / provider health / corrections / quotas were always empty.
     Switched all router calls (Routing, Dashboard, Gateway) to Cockpit's
     server-side bridge (`cockpit.http`).
  4. The dark theme relied on an injected global stylesheet whose generic class
     names (`.nav`, `.card`, `.btn`) collide with Cockpit's bundled CSS, so the
     page rendered light: boxy white tabs, black-on-grey text (Models/Services
     names), and an invisible white-on-white Power button. Forced the theme
     inline on the root container (dark bg + light text, inherited everywhere)
     and inline-styled the nav/tabs. Settings inputs styled inline too (dark
     infill, readable text, a touch larger). Dropped the redundant hostname title.
  5. `cockpit.spawn` runs with a minimal PATH omitting `/usr/local/bin`, so
     `ollama` (and tools `collect-stats.sh` calls) weren't found → "no models
     installed", empty Services, "no GPU". Every `run()` now prepends a full
     PATH, and `bootstrap.sh` actually deploys `collect-stats.sh` (it was never
     copied to `/opt/.../scripts/`, so the dashboard had no stats source).
  6. `collect-stats.sh` emitted empty JSON (bare commas) because `main()` used
     `var=$(collector) &` — the assignment ran in a backgrounded subshell, so the
     parent never saw the value. Made the collectors sequential (correct, ~1s).
     Also needs `bc` (added to bootstrap).
  7. The Terminal tab embedded ttyd via iframe, but ttyd is on `:80` while
     Cockpit serves the page on `:9090` (different origin + http/https), so the
     browser blocked it ("content is blocked"). Replaced the dead iframe with a
     launcher: buttons to open the web terminal or Cockpit's own terminal in a
     new tab.

### Added (2026-07-02 — Flywheel Phase 1: correction UI)

- **Cockpit correction panel.** The Routing → Routing log view now shows each
  decision with a ✎ *fix…* control — pick the correct role to teach the router,
  or undo an existing correction inline. Kills the curl; calls the correction API
  (`POST`/`DELETE /api/correction`). Corrected rows show a ✓ badge; an active
  count is shown above the log. Quota/image marker rows (no `id`) aren't
  correctable. The same API is what our own chat's 👍/👎 will call.

### Added (2026-07-02 — Flywheel Phase 1b: fuzzy corrections)

- **Corrections now generalize to *similar* messages, not just verbatim repeats.**
  New fuzzy `override` tier: when signal + keyword both miss, the router embeds
  the message (`nomic-embed-text` via Ollama) and cosine-kNN-matches it against
  stored corrections; a neighbour at/above `knn_threshold` (default 0.86,
  configurable in `router_roles.yaml`) wins.
- **Runs only on a fallback** — never overrides a confident signal/keyword match,
  and only adds an embed call on otherwise-general messages. Exact human
  corrections still sit above keyword.
- **Best-effort:** if `nomic-embed-text` isn't pulled or the embed call fails,
  the tier silently no-ops and exact match keeps working. Corrections are
  embedded at capture time, pinned to the embed model (cross-model vectors are
  incomparable). Pure-Python cosine — no new dependency.

### Added (2026-07-02 — Flywheel Phase 1: learned corrections)

- **The router now learns from corrections, locally.** When a human records
  "this route was wrong, it should be `<role>`", the router stores it and applies
  it to future identical messages — instantly, no restart, nothing leaves the
  box. First step of the [routing fixture flywheel](docs/PLANNED-routing-fixture-flywheel.md).
- **New `override` tier**, above the keyword classifier: an explicit human
  correction is ground truth for that message and beats the keyword guess.
  Phase 1 is exact (normalized) text match; Phase 1b will add embedding kNN so
  *similar* messages benefit.
- **Correction API:** `POST /api/correction` (by routing-log `id` or explicit
  `message`), `GET /api/corrections` (active overrides), `DELETE /api/correction`
  (undo). Storage is append-only `overrides_local.jsonl` using the existing
  `CORRECTION_SCHEMA`; **undo is a tombstone record, never a hard delete.**
- Routing-log entries now carry `id` + `context` + predicted role so a decision
  can be turned into a correction. Override replies still get the provenance tag;
  the correction UI (Cockpit panel) is the next step.

### Added (2026-07-02 — utility request lane)

- **Client housekeeping no longer routes as user intent.** Chat clients fire
  background calls — title, tags, follow-up suggestions, autocomplete — that were
  being classified and sent to the `reasoning` tier (and would hit the most
  expensive model on a cloud-backed setup). The router now detects these and
  short-circuits: skip classification, quota, MCP tools, and the provenance tag
  (tagging a generated title would corrupt it), routing to a cheap `utility`
  model. They never touch the user-facing routing log.
- **Detection is client-agnostic first:** an explicit `metadata.intent` field or
  `X-LLMSpaghetti-Intent` header (`utility`/`task`) — the path our own chat will
  use. Open WebUI's `### Task:` prompt is an isolated compatibility shim.
- New `utility` role in `router_roles.yaml` (falls back to `fast`, then
  `local-default`). Diagnosed from real hardware: OWUI's Follow-Up Generation was
  fabricating "user" turns and its title/tag calls were routing to `reasoning`.

### Added (2026-07-02 — provenance tag)

- **"Show your work" on every reply.** The router now tags each routed answer
  with the model that actually handled it — a visible footer
  (`` `↳ LLMSpaghetti → <model> · <role>` ``) plus a machine-readable
  `x_llmspaghetti` field on the response body. Router-side, so it works in every
  client (Open WebUI, VS Code, curl) with no per-client plugin.
- **Resolves the real model name** from its LiteLLM alias, so the tag shows
  `qwen2:0.5b`, not the internal `local-default` placeholder.
- **Fallback-aware:** if the primary model fails and a fallback answers, the tag
  names the fallback and sets `"fallback": true`. Covers both streaming and
  non-streaming. In streaming the footer is injected just *before* the
  `finish_reason` chunk — clients (Open WebUI) drop content that arrives after
  the stop, so a footer placed before `[DONE]` never rendered.
- Toggle with `show_provenance` in `config/router_roles.yaml` (default on).
- Implements the core "Nothing hidden — show your work" principle. See
  docs/technical.md.

### Fixed (2026-07-02 — classifier code-routing miss)

- **Code prompts with natural phrasing now route to `code`.** The keyword rule
  required the code-noun immediately after the verb (`write a function` ✅) so
  anything with adjectives in between missed (`write a reverse hello world
  python script` → wrongly `general`). Loosened the write/create/make/build/
  generate rule to allow a short run of words before the artifact, and added a
  language+noun branch (`python script`, `javascript function`). Guarded against
  false positives (`write a letter`, `write a short story` stay `general`).
  Added regression fixtures (code-06..08, edge-06..07); all pass. Surfaced by
  the new provenance tag.
- **Code-context no longer bleeds across a thread.** `_extract` was scanning
  every message for ```` ``` ```` fences — including the assistant's own code
  replies — so once a conversation showed any code, every later message stuck to
  the `code` role ("write a summary of this chat" → code). Code detection is now
  scoped to the user's current turn; assistant output doesn't count. User-pasted
  code still routes to `code`.
- **"summary" routes to `document`.** The document rule only matched
  "summarise/summarize"; the noun "summary" fell through to general. Broadened to
  `summar(y|ies|ise|ize|isation|ization)`. Added fixtures (doc-06..07); 38 pass.

### Proven (2026-07-01 — first bare-metal GPU deployment)
- **Multi-model routing proven on real GPU hardware.** Ryzen 3 3200G + RTX 2060
  Super 8GB, Ubuntu 26.04. qwen2.5:3b (general) + qwen2.5-coder:3b (code) both
  resident in VRAM (~4.3GB). Code question → coder model, general question →
  general model, automatically, both 200 OK, fast, no soft-lock. The thesis
  works on the machine it was designed for. See docs/install.md.
- **GPU driver install fixed:** use `ubuntu-drivers install` (Ubuntu's prebuilt,
  kernel-matched modules) instead of NVIDIA's `cuda-toolkit + nvidia-kernel-open-dkms`
  (the latter has no candidate on Ubuntu 26.04 and aborted the whole GPU step).
- **Bootstrap hardening from the clean install:** create `data/webui` (Open WebUI
  bind mount), `chmod 755` INSTALL_DIR (Ollama traversal), console checks
  `cockpit.socket` not `.service`, gpu-detect counts only display controllers.
- Recommended setup tip: use an iGPU for display, dedicate the dGPU to inference.
- **Router now strips client-supplied `tools`/`tool_choice`.** Open WebUI injects
  a built-in `update_task` tool; small models choke and echo the schema instead
  of answering. The router owns tool management (MCP), so client tools are
  dropped. Verified: clean "Oslo" + real Python through the Open WebUI UI.
- **Full stack proven through the chat UI**, not just the API: Open WebUI →
  router → correct model (general vs coder) → GPU → clean answer, fast.

### Proven (2026-06-27 — multi-model routing milestone, CPU VM)
- **The core thesis works.** With two local models loaded (qwen2:0.5b +
  qwen2.5-coder:0.5b), the router classifies each message and sends it to a
  DIFFERENT model automatically:
  - "write a python function to reverse a string" → `code` → code-local (coder)
  - "what is the capital of Norway" → `fast` → local-default (qwen2:0.5b)
  Verified in the router log on the VM. Routing is no longer theoretical.
- Confirmed the 500 errors were only a missing model (coder not pulled), not a
  routing fault — once pulled, the route resolved.
- **Hardware ceiling documented:** a CPU-only VM (7GB RAM, no swap) soft-locks
  running two models (kernel "soft lockup, CPU stuck [llama-server]"). Not a bug
  — CPU inference saturates all cores. Reinforces local-first-with-a-GPU as the
  primary target. CPU-VM testing should stay to one model.
- Added OLLAMA_MAX_LOADED_MODELS guidance for low-RAM boxes (limits memory, not
  CPU — doesn't cure the lockup, only a GPU/more cores does).

### Direction / decisions (2026-06-27)
- **Product reframed local-first.** Primary use case = homelab with multiple
  local models, each assigned a role. Cloud APIs are the secondary path. README
  + PROJECT-SCOPE reworded to lead with this.
- **Client strategy decided.** One smart `/v1` endpoint; the router holds ALL
  intelligence; clients (Open WebUI now, VS Code next, our own chat as end-game)
  are thin, swappable consumers. Rule: logic in the router, never client glue.
  See docs/PLANNED-client-strategy.md.
- **Principle added: "Nothing hidden — show your work."** Provenance tag on every
  reply, visible (never silent) fallbacks, inspectable routing log, GPL code.
- **Principle sharpened: "Use what we have, but smarter."** Orchestrate
  Ollama/LiteLLM/Open WebUI; never reinvent them. Own the routing brain only.
- New planning docs: model-management, background-jobs, client-strategy.

### Added (2026-06-27 — first real VM deployment)
- Confirmed full routing chain works end-to-end on Ubuntu 26.04 VM
- Python venv-based install (replaces pip --break-system-packages; required for Ubuntu 26.04 / PEP 668)
- `ENABLE_OLLAMA_API=false` on Open WebUI so every message is forced through the router
- MCP tool injection + tool-call resolution loop in router (from prior session)
- VS Code extension, Settings tab API-key management (from prior session)

### Changed (2026-06-27)
- External OpenAI-compatible API moved from `/api/v1` to `/v1` (avoids clash with Open WebUI's own `/api/`)
- LiteLLM runs with 1 worker (was 2) and no master_key (it's internal-only now)
- First-boot wizard runs on port 3001; Caddy auto-switches to Open WebUI (3000) once healthy
- `local-default` model now follows the user's first model pick (was hardcoded to llama3)
- Documented minimum disk as 50GB (20GB is insufficient for Docker image extraction)

### Fixed (2026-06-27)
- Bootstrap: create /etc/caddy, copy router/eval/config dirs, chown Ollama models dir, create api_keys.env/mcp.json
- Security: litellm_config.yaml now uses env-var references for keys; added to .gitignore
- Stack startup no longer blocks the wizard during `docker compose pull`

### Planned
- Multi-model routing demo (router picks different models per intent)
- Model management UI now that Open WebUI's Ollama API is disabled (see docs/PLANNED-model-management.md)
- Models tab: Load / Stop / Eject / Delete / per-model config panel
- Services tab: tap-to-install ComfyUI, SearXNG, Whisper, Qdrant, n8n, Flowise
- Runtime switcher: llama.cpp, vLLM as optional backends
- Bootable ISO (currently install is git clone + bootstrap.sh only)
- Intel Arc GPU support
- OTA update system
- ARM64 / Raspberry Pi 5 port

---

## Initial scaffold (2024)

Not a released product — the first pass that stood up the whole stack. Some of
this was only scaffolded here and proven later (see the 2026 entries above);
the **bootable ISO in particular is a long-term goal, not a shipped feature** —
it needs a complete, proven product first.

### Added / scaffolded
- ISO builder + autoinstall config **scaffolded only** — the working "flash a
  USB and boot" ISO is way down the roadmap (build it once the product is complete)
- Auto-detection of NVIDIA (CUDA) and AMD (ROCm) GPUs
- First-boot web wizard (hostname, timezone, SSH key, model selection, API keys)
- tty1 live console status display (services, GPU stats, IP address)
- Ollama for local model management
- Open WebUI for chat interface
- LiteLLM proxy — unified OpenAI-compatible API endpoint
- Cockpit for server management (port 9090)
- ttyd embedded web terminal (llmspaghetti user) + Cockpit root terminal
- Dashboard: live CPU, RAM, per-GPU VRAM/temp/power/util, network, disk
- `llmspaghetti` CLI: start/stop/restart/status/pull/models/config/key/gpu/doctor/update
- Watchdog service — auto-restarts failed services
- Power controls: stop models, stop services, reboot, shutdown
- Pre-build validation suite (84 checks)
- Full test suite for live installs (local + remote SSH)
- GPL v3 license
