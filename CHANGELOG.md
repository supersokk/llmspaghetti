# 🍝 LLMSpaghetti — Changelog

All notable changes to LLMSpaghetti will be documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added (2026-07-06 — SpagDesk: concurrent (non-blocking) chat)

- **SpagDesk no longer serialises requests.** A slow image (`//image clown`, ~20s)
  runs in the background — fire it, then ask "capital of Norway" and get the answer
  from fast/general *while the clown renders*. Each message streams into its own
  bubble; the send button is never disabled; the status line shows an in-flight
  count. The router was already async (FastAPI) — this stops the UI from blocking.
  (A step toward, but not the whole of, the local-background-delegation vision in
  docs/PLANNED-background-jobs.md.)

### Added (2026-07-06 — `//image` slash command to force a role)

- **Type `//image <prompt>` to force image generation**, skipping the classifier —
  e.g. `//image fish with chopsticks`. The `//role` prefix is stripped so ComfyUI
  gets a clean prompt. Works for any role (`//code`, `//reasoning`, …) and takes top
  priority (above learned corrections). Single or double slash; URLs/paths are
  safely ignored (must be a real role name + a space + prompt). Router-side, so it
  works in SpagDesk and Open WebUI alike. SpagDesk's input hints at it.

### Added / Fixed (2026-07-06 — Image model management)

- **Delete + Rename** downloaded checkpoints from the Image tab's *Installed models*
  section (delete confirms first; rename to a memorable name and, if it's the active
  engine, `image.yaml` is updated so the router still finds it).
- **Family choice now persists.** The family dropdown defaults to the *saved* family
  for the active engine, and you can change it on an already-active model — the button
  becomes **Save** when the choice differs (previously it was locked to "in use", so a
  z-image pick appeared not to stick).
- **Gated-model download progress fixed.** For token'd/gated repos the router now
  HEAD-resolves the signed CDN URL first and downloads *that* (the CDN rejected the
  stray `Authorization` header, which stalled the bar). Public downloads unchanged.

### Changed (2026-07-06 — SpagDesk is the default client; Open WebUI is now optional)

- **Open WebUI removed from the default stack** — it no longer auto-starts, freeing
  its RAM (~0.5–1 GB). "WebUI's work is done": it was the bootstrap client, and
  SpagDesk has replaced it. Install OWUI on demand from **Cockpit → Services → Chat
  clients** (runs on :3000, reaches the router via `host.docker.internal:5000`,
  reuses its old data dir so accounts/chats persist).
- **SpagDesk is served at the root `/`** by Caddy — the bare server IP now lands on
  the native workspace (still also at `/desk/`).
- **firstboot** now gates "ready" on the **router** answering (SpagDesk is static, so
  it's ready instantly) instead of waiting for Open WebUI to boot — faster first boot.
  It also deploys the **full** `stack/Caddyfile` (fixes a latent bug where firstboot
  wrote a minimal Caddyfile that dropped the `/spag`, `/desk`, `/v1`, `/images` routes).
- **Dashboard** shows a **🍝 Workspace → &lt;ip&gt;** link (opens SpagDesk) and lists the
  **Router** as a core service; the Open WebUI dot only appears when it's installed.

### Added (2026-07-06 — Faster downloads + HuggingFace login)

- **Image-tab downloads now use `aria2c -x16 -s16`** (16 parallel connections, huge
  speedup on multi-GB checkpoints) with a `wget` fallback if aria2 isn't installed.
  Same live `%` progress bar. `aria2` added to bootstrap.
- **HuggingFace token support for gated/private models.** New `HF_TOKEN` field in
  Cockpit **Settings**; downloads attach `Authorization: Bearer <token>` **only when
  it's set** (no effect on public repos, unlocks gated ones like Flux.1-dev). A
  401/403 now surfaces a clear "this model looks gated — add your HF token in
  Settings + accept the licence" message instead of a bare failure.

### Added (2026-07-06 — Tap-install architecture packs)

- **Install a new image architecture with one tap.** The Image Generator tab gains
  an **Architectures** section (catalog: `config/image-architectures.yaml`). Each
  pack = a ComfyUI workflow template + optional ComfyUI custom nodes. **Install**
  clones the custom nodes into `<comfy_dir>/custom_nodes` (as the user), drops the
  workflow template into `config/image-workflows/`, and restarts ComfyUI — the
  router then routes that family. Built-ins (SD1.5/SDXL/Flux) show as installed;
  **Remove** tears a pack's template back out.
- **Z-Image ships as the first installable pack** (experimental) — the architecture
  behind the Z-Anime model. Honestly labeled: Z-Image isn't native in mainline
  ComfyUI, so its template (`config/image-architectures/zimage.json`) is drop-in
  editable if sampling needs tuning.
- `GET /api/image-architectures` serves the catalog with per-pack `installed` state.
  This is the tap-install layer sitting on the data-driven workflow engine below.

### Changed (2026-07-05 — Data-driven image workflows in the router)

- **Image workflows are now template files, not hardcoded Python.** The router's
  `_comfy_workflow` reads `config/image-workflows/<family>.json` — a ComfyUI
  API-format graph with placeholder tokens (`{{PROMPT}}`, `{{MODEL}}`, `{{STEPS}}`,
  `{{WIDTH}}`/`{{HEIGHT}}`, `{{CFG}}`, `{{GUIDANCE}}`, `{{SEED}}`) that the router
  substitutes per request (typed: prompt/model → str, steps/size/seed → int,
  cfg/guidance → float; node wiring untouched). Ships `sd15`, `sdxl`, `flux`
  templates (byte-identical to the old graphs — no behaviour change).
- **Adding an image architecture is now a drop-in**, not a code change: a new
  `<family>.json` template (+ optionally a ComfyUI custom node) makes it routable.
  This is the low-level seam a future "install architecture" tap-install pack plugs
  into. `GET /api/image-workflows` reports the installed families.

### Added (2026-07-05 — "Free VRAM" button + honest loaded-models)

- **"Free VRAM" button on the Dashboard GPU card.** One click reclaims VRAM held by
  running services — unloads every loaded Ollama model **and** drops ComfyUI's
  cached model — **without stopping either service** (both reload on next use). For
  shared/small GPUs where an idle ComfyUI cache or leftover LLMs starve the card.
- **Loaded Models panel now reads reality.** It queried `/api/tags` (every installed
  model on disk) and stamped "in VRAM" on all of them; now it reads `/api/ps` (what's
  actually resident) with `size_vram` and badges each **in VRAM / in RAM / VRAM+RAM**
  by where it truly sits — matching the GPU VRAM stat.

### Fixed (2026-07-05)

- **Health polling no longer loads models into VRAM.** `provider-health` sent a real
  inference ping (which made Ollama load the model); the Dashboard/Routing tabs poll
  it every few seconds, so ejected models kept creeping back. Local models are now
  checked via `/api/tags` (no load); cloud models keep the light ping.
- **Image-tab downloads survive tab switches** via a module-level manager + a
  persistent progress banner (Cockpit unmounts the tab component on switch).

### Added (2026-07-05 — Add any HuggingFace image model + activate custom checkpoints)

- **"Add from HuggingFace" in the Image Generator tab.** Paste a model repo URL →
  it lists the repo's `.safetensors`, infers each file's ComfyUI destination
  (`checkpoints/`, `diffusion_models/`, `vae/`, `clip/`, `loras/`) and whether it's
  a **ready checkpoint** or a **component**, and downloads the one you pick (with a
  progress bar) into the right folder. Honest labels — a diffusion-only or new-arch
  file is placed correctly but flagged as "needs its siblings + a workflow".
- **"Installed models" section.** Checkpoints ComfyUI sees that aren't preset
  catalog engines (anything you downloaded or dropped in) can be **activated** by
  picking their family (SD 1.5 / SDXL / Flux) — the router then builds the matching
  workflow. Closes the loop: find on HF → download → activate → generate.
- **Routing tab** now shows the `image` role as *"handled by the Image Generator
  tab"* instead of a model dropdown that did nothing (the image model lives in
  `image.yaml`, not the role→model map).

### Added (2026-07-05 — ComfyUI as a managed service + first-run setup)

- **`scripts/comfyui-setup.sh`** — idempotent installer that clones ComfyUI (if
  missing), builds its venv + PyTorch, picks the VRAM flag from the actual GPU
  (`--lowvram` under 10 GB, default above, `--cpu` with no GPU), and registers a
  **systemd `comfyui.service`** so image generation **starts on boot and restarts
  on failure** — no more `nohup`. Runs as the normal user (models/venv live in
  their home); sudo only for the unit.
- **`spag comfyui <install|start|stop|restart|status|logs>`** — manage it from the CLI.
- **One-click install from the Services tab.** The ComfyUI entry is now **native**
  (host systemd service, not Docker) — status via `systemctl`, and the **Install**
  button runs the setup script. The installer works whether invoked as a normal
  user (CLI) or as root (the Cockpit button), resolving the target user itself.
- **Image Generator tab** gains a **Start ComfyUI** button when the backend is down,
  and points first-timers at `spag comfyui install`. Bootstrap now ships the setup script.

### Added (2026-07-05 — Image Generator tab + multi-engine image routing)

- **New Cockpit "Image Generator" tab.** A curated engine catalog grouped by
  hardware tier — **Low** (SD 1.5), **Better** (SDXL), **Best** (Flux.1) — each
  card showing VRAM needs and a live **GPU-fit badge** (✅ fits / ⚠ tight / 🛑
  over) computed from ComfyUI's reported VRAM. You choose; the tab informs, never
  blocks. Activate an installed engine, **download** a missing one (with a
  progress bar), tune advanced params (steps/size/cfg/negative or Flux guidance),
  and **Test** a prompt with an inline preview (read back via `cockpit.file`, so
  no mixed-content issues).
- **The router now generates per engine family.** `_comfy_workflow` builds the
  right ComfyUI graph for `sd15`/`sdxl` (basic graph) vs `flux` (SD3 latent +
  FluxGuidance, cfg 1, simple scheduler).
- **Hot-reloaded image settings.** `config/image.yaml` (active engine + params) is
  written by the tab and re-read by the router per request — switch engines with
  no restart. `config/image-engines.yaml` is the curated catalog (verified
  download URLs). Read-only router endpoints `GET /api/image-config` and
  `GET /api/image-engines` back the tab.

### Added (2026-07-05 — HuggingFace search + non-blocking pulls in Models tab)

- **Search HuggingFace for GGUF models right in the Models tab.** Ollama can pull
  GGUF straight from HF (`ollama pull hf.co/<repo>:<quant>`), so the tab queries
  HF's API server-side (via `cockpit.spawn` curl — no CORS), ranks by downloads,
  and lets you expand a repo to pick a quant (Q4_K_M, Q8_0, …) and pull it.
- **Real download progress bar** — Ollama's pull stream is parsed into a percentage
  + size bar (was a raw text log), with an indeterminate state for the manifest phase.
- **Pulls are non-blocking** — the download runs in its own strip while the search
  field stays live, so you can line up the next model instead of waiting. One
  download at a time (Ollama serialises anyway); a second attempt is politely refused.

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
- Image replies now carry a provenance footer (`↳ LLMSpaghetti → dreamshaper_8 · image`)
  and machine-readable `x_llmspaghetti` provenance, so SpagDesk's Insight rail +
  role/model pills light up for image turns too.
- **SpagDesk renders generated images inline** — a minimal DOM-based renderer
  turns `![alt](url)` into an `<img>` (whitelisted sources only, never innerHTML),
  so "draw me a …" shows the picture in the same chat instead of raw markdown.
  Everything the manifesto listed now happens in one chat, no app-switching.

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
