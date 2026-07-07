# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[Report a vulnerability](https://github.com/supersokk/llmspaghetti/security/advisories/new)**
button (Security tab → Advisories). This opens a private thread with the
maintainers. We'll acknowledge within a few days and work with you on a fix and
disclosure timeline.

If you can, include: what you found, how to reproduce it, and the impact.

## Supported versions

LLMSpaghetti is pre-1.0 and moves fast. Security fixes land on **`main`**; run the
latest and re-deploy (`spag update`). Older checkouts are not separately patched.

## Security model (what to expect)

LLMSpaghetti is a **self-hosted LAN appliance**, not an internet-facing service by
default. The security posture assumes a trusted local network:

- **The router and LiteLLM bind to `127.0.0.1`** (localhost) and sit behind Caddy.
  They are not directly reachable from the network.
- **Cockpit** (port 9090) has its own TLS + login and is the admin surface.
- **The LiteLLM master key is generated randomly per install** (`sk-spag-<random>`,
  stored `0600` in `config/master_key`, never committed).
- The client→router bearer token defaults to `sk-llmspaghetti` — a **local
  convenience default**, fine on a trusted LAN.

### If you expose the box beyond your LAN

Putting LLMSpaghetti on the public internet (e.g. Caddy with a domain + TLS)
changes the threat model. Before doing so:

- **Change the default `sk-llmspaghetti` token** and set a strong master key.
- Put **authentication in front of** the chat/API endpoints (Caddy basic-auth,
  an SSO proxy, a VPN/Tailscale, etc.).
- Lock down **Cockpit** (strong OS account passwords; ideally VPN-only).
- Treat **cloud API keys** in `config/api_keys.env` as production secrets.

## Handling secrets

- Never commit real keys. `config/api_keys.env`, `config/master_key`,
  `config/litellm_config.yaml`, and `**/overrides_local.jsonl` are gitignored.
- If a secret is ever exposed, **rotate it** at the provider immediately — Git
  history is forever.
