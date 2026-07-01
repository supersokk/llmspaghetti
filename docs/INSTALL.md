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
| **Reference box (2026-06-27)** | Ryzen 3 3200G (4c), 16GB DDR4, 240GB SSD, **RTX 2060 Super 8GB** (NVIDIA), AMD Vega iGPU for display | ✅ installs; GPU live (driver 595, CUDA 13.2) — routing test in progress |
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

### 3. GPU / driver notes (this box)

- **NVIDIA CUDA only, ROCm correctly skipped.** ✅ Confirmed: detection sees the
  NVIDIA card first (`cuda-pending`) and does *not* install ROCm for the
  display-only Vega iGPU. No change needed.
- **We install the driver via `sudo ubuntu-drivers install`, not NVIDIA's CUDA
  toolkit.** Ollama bundles its own CUDA runtime — it only needs the driver.
  Ubuntu's packaged driver uses prebuilt kernel modules matched to your kernel,
  which is robust and works on brand-new Ubuntu releases.
- Result on this box: `nvidia-driver-595` installed, reboot, then `nvidia-smi`
  shows **RTX 2060 SUPER, 8192 MiB, CUDA 13.2**. ✅
- After the driver reboot, refresh the GPU cache so the console/wizard see it:
  ```
  sudo bash llmspaghetti/scripts/gpu-detect.sh --json | sudo tee /opt/llmspaghetti/gpu-info.json
  sudo systemctl restart ollama       # so Ollama picks up the GPU
  ```

### 4. First-boot wizard

Open `http://<server-ip>` → hostname/timezone → pick models → (optional) API
keys → done. Models download in the background; the wizard returns immediately.

---

## Gotchas found on real hardware

- **NVIDIA driver on Ubuntu 26.04 (2026-06-27).** The old GPU script installed
  `cuda-toolkit + nvidia-kernel-open-dkms + cuda-drivers` from NVIDIA's CUDA repo.
  On 26.04, `nvidia-kernel-open-dkms` had **no installation candidate**, and
  because `apt install` is atomic, the whole GPU step aborted → bootstrap fell
  back to CPU mode. **Fix:** install the driver with `sudo ubuntu-drivers install`
  (Ubuntu's prebuilt, kernel-matched modules). Ollama only needs the driver, not
  the CUDA toolkit. The script now does this automatically. If you hit CPU-mode
  after a bootstrap on a GPU box, just run `sudo ubuntu-drivers install`, reboot,
  refresh `gpu-info.json`, and restart Ollama.
- **Dual GPU (NVIDIA dGPU + AMD iGPU) routed correctly** — detection picks CUDA,
  skips ROCm. No action needed.
- **Ollama crash-loop: "mkdir /opt/llmspaghetti/models: permission denied —
  ensure path elements are traversable" (2026-07-01).** Ollama runs as the
  `ollama` user and couldn't traverse `/opt/llmspaghetti` (owned by the
  `llmspaghetti` user, not world-traversable). **Fix:** `chmod 755
  /opt/llmspaghetti` + `chown -R ollama:ollama /opt/llmspaghetti/models`.
  Bootstrap now does this. Symptom: `ollama list` says "could not connect".
- **Open WebUI won't start: "mount /opt/llmspaghetti/data/webui: no such file
  or directory" (2026-07-01).** The container's data volume binds `data/webui`,
  which bootstrap created as `data/` only. **Fix:** `mkdir -p
  /opt/llmspaghetti/data/webui`. Bootstrap now creates it. Symptom: router +
  litellm containers stuck in "Created", webui never created.

---

## Post-install checks

```
sudo docker ps                     # webui, litellm, router all Up
nvidia-smi                         # GPU visible + driver loaded
ollama list                        # models present
sudo docker logs llmspaghetti-router --tail 10   # routing decisions
```

Open `http://<server-ip>` for chat, `http://<server-ip>:9090` for Cockpit.
