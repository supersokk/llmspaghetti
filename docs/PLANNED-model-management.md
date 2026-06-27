# ⏸ PLANNED — Model management after disabling Open WebUI's Ollama API

> Status: needs design thinking. Raised 2026-06-27 during first VM test.

## The problem

To guarantee that **every** message goes through the router (the whole point
of the product), we set `ENABLE_OLLAMA_API=false` on Open WebUI. If we didn't,
a user could select a native Ollama model in the chat dropdown and talk to it
directly, bypassing all routing.

**Consequence:** Open WebUI's built-in model manager (Settings → Models → Pull)
is now gone. The user can no longer pull, delete, or inspect models from the
chat UI. Today the only ways to manage models are:

- `ollama pull <model>` over SSH / web terminal
- `spag pull <model>` CLI
- (intended) the Cockpit **Models tab**

This is acceptable for a technical user but breaks the "just works" promise for
the target audience (someone with an old laptop who pasted in API keys).

## What needs deciding

1. **Where does model management live?**
   - Option A: Cockpit Models tab becomes the single place. Pull/delete/load,
     VRAM budget bar, per-model config. (Already scoped in Phase 3.)
   - Option B: A custom Open WebUI "function"/pipeline that re-exposes pull
     through the router. More work, keeps users in one window.
   - Leaning A — Cockpit is already our management plane.

2. **How does a freshly-pulled model become routable?**
   - Pulling via Ollama doesn't add it to `litellm_config.yaml`, so the router
     can't target it. Right now only `local-default` (one model) is wired up.
   - Need: when a model is pulled, auto-add a LiteLLM `model_list` entry and
     make it assignable to a role. Otherwise pulled models are invisible to
     routing — exactly the confusion we hit on day one with llama3 vs phi3.

3. **The role → model mapping UX.**
   - `router_roles.yaml` maps roles to model_names. A non-technical user needs
     a UI: "reasoning → [dropdown of installed models]". This is the Routing
     tab's job but it must read the live list of what's actually pulled +
     configured, not a hardcoded list.

4. **First-run default.**
   - Wizard should pull at least one model and wire it to ALL roles so the
     appliance works immediately, then let the user specialise roles later.

## Why this matters

The single biggest source of confusion in the first test was the mismatch
between "what's pulled in Ollama" and "what LiteLLM/the router knows about."
A model that exists but isn't in the config is useless to the router, and a
config entry pointing at an un-pulled model fails silently. Model management
and routing config must be **the same action**, not two disconnected steps.

## Related
- Phase 3 (Models tab) in [TODO.md](../TODO.md)
- `config/router_roles.yaml`, `config/litellm_config.yaml`
- The day-one bug: local-default → ollama/llama3 (never pulled) → empty responses
