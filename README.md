# 🍝 LLMSpaghetti

![LLMSpaghetti](docs/logo.png)

> A tangled mess of AI routing that somehow works.

One endpoint. One chat window. Every model you have — local and cloud —
and it silently sends each message to the right one.

---

> ⚠️ **HONEST DISCLAIMER — PLEASE READ**
>
> This is a **hobby project** built for fun. The code is, by the author's own
> admission, **vibecoded spaghetti** — held together with bash, enthusiasm, and a
> concerning amount of optimism.
>
> **Use at your own risk.** The authors take zero responsibility for anything
> that happens to your hardware, data, API bills, pets, or general wellbeing as a
> result of running this software. No warranty, no support, updates when they
> happen. Full terms: [DISCLAIMER.md](DISCLAIMER.md).

---

## What is it?

LLMSpaghetti turns a spare PC into a self-hosted **AI router**. You talk to a
single chat window; behind it, a router reads each message, works out what you
need, and routes it to the best model — a local coder model for code, a
reasoning model for "think this through", a cloud model if you want one — all
without you choosing. One URL for every OpenAI-compatible tool (Cursor,
Continue, Aider, your own scripts).

```
You  →  one chat / one /v1 endpoint  →  Router (classifies)  →  the right model
                                                                 (local or cloud)
```

## Why build it?

Anyone using AI seriously ends up juggling six tabs and four API keys, manually
picking a model per task and sending everything to the cloud whether it needs to
go there or not. LLMSpaghetti collapses that into one place **you** own.

- **Local-first (the point):** a homelab box with a GPU, several local models,
  each assigned a job. Nothing leaves your network unless you add a cloud key.
- **Or router-only:** an old laptop with no GPU that just routes your existing
  cloud subscriptions through one endpoint for every device in the house.

You set the rules. LLMSpaghetti enforces them — and **shows its work** (every
answer will tell you which model handled it).

---

## Status

**Works today** (proven on a real GPU box — RTX 2060 Super, Ubuntu 26.04):
install → setup wizard → chat, with **multi-model routing** sending different
messages to different local models automatically, GPU-accelerated.

**Not built yet:** the bootable ISO (install is `git clone` + bootstrap for now),
image routing, the VS Code extension, multi-node. Full picture in
[TODO.md](TODO.md) and [CHANGELOG.md](CHANGELOG.md).

---

## Milestones

- **First GPU deployment** — *2026-07-01* — full stack on real hardware
  (RTX 2060 Super); code vs general questions routed to different local models
  through the chat UI, fast, no soft-lock.
- **Routing proven** — *2026-06-27* — end-to-end classify → route → reply on a
  CPU VM; the core thesis works.

---

## Documentation

| I want to… | Go to |
|---|---|
| Install & set it up | [docs/install.md](docs/install.md) |
| Understand how it works | [docs/technical.md](docs/technical.md) |
| Read the vision / scope | [PROJECT-SCOPE.md](PROJECT-SCOPE.md) |
| See what's planned / done | [TODO.md](TODO.md) |
| See what changed | [CHANGELOG.md](CHANGELOG.md) |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Browse all docs | [docs/](docs/README.md) |

---

## Security

LLMSpaghetti is a **self-hosted LAN appliance** — the router and LiteLLM bind to
`localhost` behind Caddy, and the master key is generated randomly per install. If
you expose the box to the internet, harden it first (change the default token, add
auth in front of the endpoints, lock down Cockpit). See
**[SECURITY.md](SECURITY.md)** for the security model and how to report a
vulnerability privately.

---

## Acknowledgements

LLMSpaghetti is glue and a routing brain on top of excellent open-source
projects. It would not exist without them:

- **[Ollama](https://ollama.com)** — runs the local models
- **[Open WebUI](https://github.com/open-webui/open-webui)** — the chat interface
- **[LiteLLM](https://litellm.ai)** — unified gateway to 100+ providers
- **[Llama](https://ai.meta.com/llama/)** and the wider open-weight model
  community (Qwen, Mistral, Gemma, DeepSeek, …) — the models that make local
  inference possible
- **[Cockpit](https://cockpit-project.org)** · **[ttyd](https://github.com/tsl0922/ttyd)** ·
  **[Caddy](https://caddyserver.com)** · **[Docker](https://www.docker.com)** ·
  **Ubuntu** — the appliance plumbing

We orchestrate these tools; we don't reinvent them. Thank you to everyone who
builds and maintains them.

---

## License

GPL v3 — see [LICENSE](LICENSE). Use it, modify it, share your changes.

---

*Yes, it's spaghetti. Yes, it works. Somehow.* 🍝
