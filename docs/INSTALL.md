# 🍝 LLMSpaghetti — Install Guide (bare-metal)

> Living document. Built from a **real install on physical hardware**, updated
> as we learn. If a step here doesn't match reality, that's a bug — fix it.
>
> Current install path is **git clone + bootstrap.sh** (the ISO doesn't exist
> yet). Works on a fresh minimal Ubuntu Server.

---

## Tested hardware

| Config | Details | Result |
|---|---|---|
| **Reference box (2026-06-27)** | Ryzen 3 3200G (4c), 16GB DDR4, 240GB SSD, **RTX 2060 Super 8GB** (NVIDIA), AMD Vega iGPU for display | 🚧 in progress |
| CPU-only VM | Ubuntu 26.04, 4 vCPU, 7GB RAM, no GPU | ✅ installs & routes; can't run 2 models (CPU ceiling) |

> 💡 **Tip — dedicate the dGPU to inference.** If your CPU has an integrated GPU
> (like the Ryzen's Vega), plug the monitor into the **iGPU** and leave the
> NVIDIA card headless. All 8GB VRAM stays free for models instead of the desktop.
> On a headless server (SSH only) this matters even less, but it's the ideal setup.

---

## Prerequisites

- **Ubuntu Server 26.04 LTS** (also 22.04 / 24.04), minimal install
- SSH access to the machine
- **Outbound HTTPS** (bootstrap pulls Docker, Ollama, CUDA, container images).
  Note: `ping` may be blocked by your network even when HTTPS works — test with
  `curl -sI https://get.docker.com` instead.
- **Disk: 50GB minimum.** Docker images ~5GB, plus every model you pull. The
  reference box has 87GB free and we'll watch it.
- For local models: an NVIDIA (CUDA) or AMD (ROCm) GPU. CPU works but is slow
  and can't comfortably hold more than one small model.

### Verify your starting point

```
lsb_release -a                     # Ubuntu version
nproc ; free -h ; df -h /          # CPU / RAM / disk
lspci | grep -i -E 'vga|nvidia'    # GPU visible?
getent hosts github.com            # DNS works?
curl -sI https://get.docker.com    # outbound HTTPS works? (not ping)
```

**Reference box verified starting state (2026-06-27):**
```
Ubuntu 26.04 LTS (resolute) · 4 cores · 13Gi RAM free · 87G free on /
GPU: NVIDIA RTX 2060 SUPER (TU106) + AMD Vega iGPU (display)
NVIDIA driver: not present (fresh install — bootstrap installs it)
DNS: OK · HTTPS out: HTTP/1.1 200 OK
```

---

## Install

> Steps below are executed and annotated as we go — real output, real gotchas.

### 1. Get the code

```
# Private repo for now — authenticate with GitHub CLI first:
sudo apt update && sudo apt install -y gh git
gh auth login          # choose GitHub.com → HTTPS → login via browser
git clone https://github.com/supersokk/llmspaghetti.git
```
_(When the repo is public, this is just `git clone` — no auth.)_

### 2. Run bootstrap

```
sudo bash llmspaghetti/scripts/bootstrap.sh
```

What it does: system update → creates the `llmspaghetti` user + dirs → **GPU
detection + driver install** → Docker → Ollama → Cockpit → web terminal → Caddy
→ Python venv → systemd services → starts the first-boot wizard.

> ⏳ Expect ~10–20 min. **NVIDIA driver install may require a reboot** — bootstrap
> drops a `.needs-reboot` flag and the console will tell you. After reboot the
> wizard is waiting at `http://<server-ip>`.

### 3. GPU / CUDA notes (this box)

- We want **NVIDIA CUDA only.** The AMD Vega iGPU is display-only — do **not**
  install ROCm for it. _(TODO: confirm install-gpu-drivers.sh handles a
  NVIDIA-dGPU + AMD-iGPU box without pulling ROCm — annotate result here.)_

### 4. First-boot wizard

Open `http://<server-ip>` → hostname/timezone → pick models → (optional) API
keys → done. Models download in the background; the wizard returns immediately.

---

## Gotchas found on real hardware

_(Filled in as we hit them — this is the most valuable part of the doc.)_

- _pending_

---

## Post-install checks

```
sudo docker ps                     # webui, litellm, router all Up
nvidia-smi                         # GPU visible + driver loaded
ollama list                        # models present
sudo docker logs llmspaghetti-router --tail 10   # routing decisions
```

Open `http://<server-ip>` for chat, `http://<server-ip>:9090` for Cockpit.
