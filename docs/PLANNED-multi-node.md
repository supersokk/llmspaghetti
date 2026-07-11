# PLANNED — Multi-node (core + compute nodes)

**Status:** design. Most of it is **buildable and testable now** using the RTX
2060S box as the first node — no special hardware needed. Only AMD-Vulkan
*compute* verification waits for the BC-250s. Control model chosen: **SSH push**.

---

## Topology

One **core**, N **compute nodes**, all on a trusted LAN.

- **Core** (e.g. the HP EliteBook — CPU-only is fine): router, LiteLLM, Caddy,
  Cockpit, SpagDesk, first-boot. The control plane + UI. Runs only the tiny
  `nomic-embed-text` (~300MB, CPU) for the routing flywheel — no chat/image models.
- **Node** (BC-250s; 2060S box for testing): **Ollama** (GPU: AMD-Vulkan / NVIDIA /
  CPU) and optionally **ComfyUI**. Pure compute. No Docker, no router, no web stack.

```
SpagDesk / IDE ─▶ Core (classify + route) ─┬─▶ node1  Ollama :11434  (coder, chat)
                                            ├─▶ node2  Ollama :11434  (reasoning)
                                            └─▶ node2  ComfyUI :8188  (image)
```

## Control model — SSH push (chosen)

The core manages nodes by running commands **over SSH** — the Services-tab pattern
aimed at a remote host. Reuses every install script we already have
(`comfyui-setup.sh`, `install-gpu-drivers.sh`, `ollama pull`, systemctl…), just
targeting the node instead of localhost.

- **"Install ComfyUI" on node2** → core runs `ssh node2 "sudo bash …/comfyui-setup.sh"`
- **"Pull qwen2.5-coder:3b" on node1** → `ssh node1 "ollama pull qwen2.5-coder:3b"`
- **Status / VRAM** → `ssh node "ollama ps"` or curl the node's `/api/ps` — **no
  agent needed** for stats.

Rejected alternatives: node-agent HTTP API (build+secure another root-capable
service for little gain), Cockpit multi-host (still SSH, needs cockpit-bridge on
the node), orchestrators (k3s/Nomad — heavy, containerizes everything, fights the
lean-node goal), pull-agent (only needed for off-LAN/NAT nodes — not our case).

### Trust & security (state it plainly)

- The core holds **passwordless root-over-SSH on every node** — that's the point
  (central control), acceptable on a trusted homelab LAN, but a real trust edge.
- Node Ollama is **LAN-exposed, no auth** (`OLLAMA_HOST=0.0.0.0:11434`). Fine
  behind your router; the node join should offer to **firewall it to the core's
  IP** (ufw allow from `<core>` to 11434, deny else).
- Off-LAN nodes are out of scope; that's when you'd switch to a pull-agent.

## Node join — the one thin bootstrap

A small one-time step on the node (far lighter than the core bootstrap):

1. GPU drivers via existing `gpu-detect.sh` + `install-gpu-drivers.sh` (BC-250 →
   the AMD-Vulkan path from PR #4; NVIDIA/CPU handled too).
2. Install **Ollama** (native, `ollama.com/install.sh`).
3. Expose on the LAN: systemd drop-in `OLLAMA_HOST=0.0.0.0:11434`
   (+ `OLLAMA_KEEP_ALIVE` per taste).
4. **Authorize the core's SSH key** (`authorized_keys`) so the core can push from
   then on. Optional ufw rule to the core IP.
5. Print the node IP + "add it in Cockpit → Nodes".

Delivered as `scripts/node-bootstrap.sh` (self-cloning like the main bootstrap, so
`curl … | sudo bash` works), or `spag node join <core-ip>`.

## Core-side pieces

- **Node registry** — `config/nodes.yaml`: `id, host/ip, ssh_user, roles/models it
  serves, has_comfyui`. Read by the router + the Nodes tab.
- **Cockpit "Nodes" tab** — add/remove nodes; per-node **install buttons**
  (Ollama, ComfyUI, ROCm), **model pulls**, **status** (VRAM/loaded via `ollama
  ps`), restart/free-VRAM. Mirrors the Services tab, SSH-targeted.
- **Routing → node** — the deferred model→backend map, now with the backend a
  **machine**: a model's node determines which Ollama URL the router forwards to
  (instead of `host.docker.internal`). ComfyUI URL likewise per image node.

## What's testable now (2060S as node-1)

- `node join` on the 2060S box; SSH from the core; push a ComfyUI install / a
  model pull; route a role to it. The whole mechanism — no BC-250 needed.

## Waits for the BC-250s

- Verifying Ollama-**Vulkan** actually offloads on that specific card.
- Per-node placement across *two* GPU nodes + failover.

## Open questions

- Node registry: flat `nodes.yaml`, or fold node into the existing role→model
  config (model gains a `node:` field)?
- SSH key: generate a dedicated core→node keypair at first node-join, stored where
  the router container and Cockpit can both use it?
- Model catalog per node vs. global: does the core track which models live on
  which node (so routing is exact), or query each node's `/api/tags` live?
- ComfyUI: one image node, or any node with a GPU? (Router picks the ComfyUI URL
  from the node serving `image`.)
