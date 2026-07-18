# Documentation Index

All LLMSpaghetti documentation lives here. Start with the
[project README](../README.md) for the overview.

## Guides

- [install.md](install.md) — install, configure, connect tools, update, troubleshoot
- [how-routing-works.md](how-routing-works.md) — **start here** for the smart router: keyword → memory → context model, in plain language
- [technical.md](technical.md) — architecture, request flow, roles, components, tech stack

## Root documents

- [../README.md](../README.md) — project overview and landing page
- [../PROJECT-SCOPE.md](../PROJECT-SCOPE.md) — vision, goals, principles
- [../TODO.md](../TODO.md) — active work and roadmap status
- [../CHANGELOG.md](../CHANGELOG.md) — project history
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — how to contribute
- [../DISCLAIMER.md](../DISCLAIMER.md) — honest disclaimer
- [../DOCUMENTATION_GUIDELINES.md](../DOCUMENTATION_GUIDELINES.md) — where docs belong

## Planning docs (not yet implemented)

Forward-looking designs — problem, options, open questions. Kept current or
folded into permanent docs once built.

- [PLANNED-spagdesk.md](PLANNED-spagdesk.md) — the native workspace client (building now, MVP-first)
- [PLANNED-client-strategy.md](PLANNED-client-strategy.md) — one smart endpoint, thin clients; our own chat as end-game
- [PLANNED-model-management.md](PLANNED-model-management.md) — making pulled models + tools routable
- [PLANNED-background-jobs.md](PLANNED-background-jobs.md) — local GPU does grunt work in the background
- [PLANNED-routing-fixture-flywheel.md](PLANNED-routing-fixture-flywheel.md) — how routing corrections improve the classifier
- [PLANNED-smart-routing.md](PLANNED-smart-routing.md) — the 3-vote ensemble (keyword + kNN + opt-in context model); the arbitration framework the community model plugs into
- [PLANNED-router-model.md](PLANNED-router-model.md) — a community-trained classifier model
- [PLANNED-private-role.md](PLANNED-private-role.md) — the "private/local" role (paused, needs design)
- [PLANNED-multi-gpu.md](PLANNED-multi-gpu.md) — multi-GPU model placement, CPU/RAM residency, pin-vs-pool (parts testable on 1 GPU; core deferred to 2-GPU hardware)
- [PLANNED-multi-node.md](PLANNED-multi-node.md) — core + compute nodes over SSH-push (node join, Cockpit Nodes tab, per-node routing; proven with the 2060S as node-1)
- [PLANNED-bc250-node.md](PLANNED-bc250-node.md) — AMD BC-250 compute node on CachyOS (delegates board magic to the community bc250-toolkit; a thin Ollama-node layer; unverified until hardware)

## Assets

- `architecture.svg` — system architecture diagram
- `logo.png` — project logo
