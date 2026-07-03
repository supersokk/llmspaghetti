# 🍝 LLMSpaghetti — TODO

Active work and roadmap. Shipped history lives in [CHANGELOG.md](CHANGELOG.md);
feature designs live in the [PLANNED-* docs](docs/README.md).

**Legend:** ✅ done · 🚧 in progress / partial · ☐ not started

---

## ⏭ Next up

- ✅ **Provenance tag** — router appends `↳ answered by <model>` to each reply
  (visible footer + machine-readable `x_llmspaghetti` field), fallback-aware,
  streaming + non-streaming. Toggle with `show_provenance`. Works in every
  client. See [technical.md](docs/technical.md#provenance--show-your-work).
- ☐ Image routing (see Phase 1)
- ☐ Add **Cerebras** as a cloud provider (free-tier keys; LiteLLM supports
  `cerebras/<model>`) — add to Settings API-keys + wizard + litellm_config.

---

## 🔥 Phase 1 — Core routing (the product)

- ✅ Routing middleware between Open WebUI and LiteLLM
- ✅ Intent detection from message content (keyword classifier)
- ✅ Silent, automatic role → model selection
- ✅ Routing enforced — Open WebUI's Ollama API disabled, can't be bypassed
- ✅ Multi-model routing proven on GPU (code → coder, general → general)
- ✅ `reasoning` / `code` / `fast` / `general` roles routing correctly
- 🚧 `document` role (large-context) — classifier matches, untested
- ☐ `image` role — detect image requests → DALL-E or ComfyUI → inline in chat,
  saved to `/opt/llmspaghetti/images/`, served over HTTP
- ☐ `private`/`local` role — ⏸ needs design ([PLANNED-private-role.md](docs/PLANNED-private-role.md))
- ✅ Visible "answered by X" tag (provenance — done, see Next up)
- ☐ Full demo in one chat session: image + reasoning + code + private + fast

---

## 🎛 Phase 2 — Control plane UI

- ☐ Visual routing-rule editor (keyword rules, priority, per-route logging)
- ☐ Model-roles config panel (assign roles via UI, not YAML)
- ☐ Provider health monitoring (live latency, auto-deprioritise degraded)
- ☐ Fallback chains (primary → fallback; private role fails loudly, no fallback)
- ☐ Quota management (per-provider limits, warn at 80%, block at 100%)
- ☐ Auto/Single routing-mode switcher in the chat header (backend supports both;
  UI toggle not built — the "answered by X" indicator now ships as the
  provenance footer, see [technical.md](docs/technical.md#provenance--show-your-work))

---

## 🗂 Phase 3 — Models tab

- ☐ Load / Stop / Eject / Delete buttons
- ☐ Live VRAM budget bar
- ☐ Per-model config (system prompt, temperature, context length, GPU layers)
- ☐ Modelfile snapshot → restore defaults
- ☐ Runtime selector (Ollama / llama.cpp / vLLM)
- ☐ Make pulled models auto-routable — ⚠️ open design ([PLANNED-model-management.md](docs/PLANNED-model-management.md))

---

## 🔌 Phase 4 — Services & MCP tools (tap-to-install)

- ☐ Image gen: ComfyUI, Automatic1111
- ☐ Data/search: SearXNG, Qdrant, Whisper
- ☐ Automation: n8n, Flowise
- 🚧 MCP tools (filesystem, memory, fetch, brave, github, sqlite, postgres) —
  Services install UI + router injection built; per-role config + test buttons pending
- ☐ Active-tools indicator in the chat header

---

## 🖥 Phase 5 — Terminal & updates

- ✅ `spag update` (apt, Ollama, Docker images, Python venv deps)
- ☐ Friendly guided terminal menu (numbered options, falls through to bash)

---

## 🏗 Phase 6 — ISO + broader testing

- ✅ Boot → wizard → routing test on real GPU hardware (RTX 2060 Super, 26.04)
- ✅ CPU-only VM test (one small model; documented CPU ceiling)
- ✅ Minimum disk documented (50 GB)
- ☐ **Build the bootable ISO** (Subiquity autoinstall → silent install → wizard)
- ☐ 🙌 Community task: minimal OS base — build UP from `ubuntu-server-minimal`
  (not strip down), document what's removed, test on real hardware
- ☐ Bootstrap should create a swap file (test box had none)
- ☐ Router-only mode on an old no-GPU laptop
- ☐ AMD ROCm + multi-GPU verification
- ☐ Automated QEMU boot test

---

## ⚙️ Phase 7 — Optional runtimes

- ☐ llama.cpp server backend
- ☐ vLLM backend (NVIDIA only)

---

## 🌐 Phase 8 — Multi-node

Structure is node-aware already; implementation is future.

- ☐ Worker join script (one command)
- ☐ Node discovery (mDNS + manual fallback)
- ☐ Nodes panel, cross-node routing + load balancing, failover
- ☐ CPU inference node role
- ☐ Storage node — deferred until requested

---

## 💻 Phase 9 — VS Code extension

- 🚧 Thin connector (one URL field, status bar, setup webview) — built, needs testing
- ☐ Publish to the VS Code marketplace

Deliberately not doing: custom slash commands, tool-specific config guides — it's
a thin client; paste the URL, done.

---

## 🪟 SpagDesk — our own workspace client (building now)

The router is the product; it needs the interface it was designed to have. Full
vision + roadmap in [PLANNED-spagdesk.md](docs/PLANNED-spagdesk.md). Built
MVP-first, buildless (static) until complexity earns a build step. OWUI stays in
parallel.

- 🚧 **Phase 0 — terminal window.** Static single-page client, streamed chat via
  `/v1`, served by Caddy at `/desk/`. (built, needs box test)
- 🚧 **Phase 1 — router visible + reuse the loops.** Native Router Insight panel
  (from `x_llmspaghetti`), inline ✎-fix correction (→ `/api/correction`).
  (built, needs box test) · `intent: utility` for its own housekeeping (todo).
- ☐ **Phase 2 — workspace shell** (left/center/right rails, files, projects).
- ☐ **Phase 3+** — compare responses, image browser, MCP timeline, templates.
- ☐ Rule throughout: logic in the router, the client stays thin.

---

## 🔁 Routing flywheel — learn from corrections

Local-first learning loop; full design in
[PLANNED-routing-fixture-flywheel.md](docs/PLANNED-routing-fixture-flywheel.md).

- ✅ **Phase 1 — capture engine (router-side).** `override` tier (exact match,
  beats keyword), `overrides_local.jsonl` store, correction API
  (`POST`/`GET`/`DELETE /api/correction`), tombstone-not-delete, routing-log
  entries carry `id` + `context`.
- ✅ **Phase 1 — capture UI.** Cockpit Routing → Routing log: per-decision
  ✎ "fix…" role picker + inline undo, corrected-row ✓ badge, active count (calls
  the correction API). Our own chat will reuse the same API with native 👍/👎.
- ✅ **Phase 1b — fuzzy match.** Embed messages (`nomic-embed-text` via Ollama),
  cosine-kNN over stored corrections so *similar* messages benefit (not just
  exact repeats). Runs only on a fallback; `knn_threshold` configurable;
  best-effort if the embed model isn't pulled. (Needs `spag pull nomic-embed-text`
  on the box to activate.)
- ☐ **Phase 2 — community.** Export (embedding + metadata, text stripped),
  maintainer merge pipeline with the **eval-gate** on a golden set, soft-merge.

## 🧠 Community router model (long-term)

A community-trained classifier to beat the keyword router. Full design +
prerequisites in [PLANNED-router-model.md](docs/PLANNED-router-model.md).

---

## 📝 Docs & polish

- ✅ Documentation restructured per [DOCUMENTATION_GUIDELINES.md](DOCUMENTATION_GUIDELINES.md)
- ☐ Hardware compatibility table (grow as people report)
- ☐ Audit privacy wording across all docs
