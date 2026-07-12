# PLANNED — AMD BC-250 compute node (CachyOS)

**Status:** design. The **platform is community-proven** — the
[BC-250 wiki](https://elektricm.github.io/amd-bc250-docs/) documents it as *"a
low-cost home AI server (Ollama + Vulkan inference up to 35B MoE models)"* (ref
build: `akandr/bc250`). So the big risk — *does Ollama offload on cyan skillfish?* —
is **retired: yes, via Vulkan/RADV.** What's unbuilt is **our thin node layer**
(`bc250-node-bootstrap.sh`) + its place in the multi-node runbook, written and
verified on real hardware. It's a niche path on purpose (a *different distro*,
because that's where the community cracked the board). Fits
[PLANNED-multi-node.md](PLANNED-multi-node.md) as node2/node3.

**Authoritative reference: <https://elektricm.github.io/amd-bc250-docs/>** — a full
BC-250 wiki. This doc is the *LLMSpaghetti-node plan*; the wiki is the source of
truth for board/BIOS/driver steps. Don't duplicate it — follow it.

---

## What the BC-250 is (and why it's special)

The AMD BC-250 is a cheap ex-crypto-miner board: a semi-custom **"cyan skillfish"**
APU (RDNA2-class GPU + Zen2 cores) with ~16GB. Stock it's locked down, but the
community has cracked it open:

- **Unlock compute units 24 → 40** — a huge free performance bump, via
  [WinnieLV/bc250-cu-live-manager](https://github.com/WinnieLV/bc250-cu-live-manager).
- **Power governors** — much lower idle draw:
  [bc250-collective/bc250_smu_oc](https://github.com/bc250-collective/bc250_smu_oc)
  (CPU SMU) + [filippor/cyan-skillfish-governor](https://github.com/filippor/cyan-skillfish-governor)
  (GPU).

Most of this is packaged in **one community script**,
[redbeard1083/bc250-toolkit](https://github.com/redbeard1083/bc250-toolkit) — an
interactive menu (Initial Setup / Performance Profiles / Revert) that **targets
CachyOS + the Limine bootloader** ("must be using Limine for all functions to
work"). It sets the governors, a 16GB Btrfs swapfile (`swappiness=180`), ZSWAP+lz4,
and disables ZRAM. It does **not** touch Ollama or any LLM stack — that's our layer.

## Why a separate path (not the Ubuntu node bootstrap)

- Different distro (**CachyOS**, Arch-based → `pacman`, not `apt`) and bootloader
  (**Limine**). Our `install-gpu-drivers.sh` / `node-bootstrap.sh` are Ubuntu-specific.
- The board magic (CU unlock, governors) is community work we **delegate**, not
  reimplement — it will drift, and they know the hardware.
- Goal is **max resources to models**: minimal/headless CachyOS, no desktop.

## Version requirements (BC-250 GPU)

The community pins these for the cyan-skillfish GPU to drive properly — a version
outside them **silently kills the GPU and falls back to CPU**, the one failure a
compute node can't have. The bootstrap should check `glxinfo`/`vulkaninfo` (Mesa)
and `uname -r` (kernel) and **warn loudly** if outside range.

- **Mesa** — **25.1.3+ minimum, 25.1.5+ recommended** for proper RADV (Vulkan) support.
- **Kernel** — **AVOID 6.15.0–6.15.6 and 6.17.8–6.17.10** (known GPU driver failures).
  Use **6.18.18 LTS (recommended)**, 6.19.x stable, or 6.17.11+.

CachyOS ships bleeding-edge Mesa + kernels, so it *probably* satisfies both — but
"probably" isn't good enough for the GPU, so check explicitly on the actual image.

## Hardware & install gotchas (from the wiki — follow it, don't trust memory)

- **Unified memory** — 16GB GDDR6 *shared* between CPU and GPU (APU-style). BIOS
  sets a **512MB dynamic VRAM allocation** (P3.00 BIOS recommended); "dynamic" means
  the GPU grows into system RAM as needed — that's how up-to-35B-MoE fits.
- **`nomodeset` during OS install**, then **remove it once the Mesa/kernel/RADV
  drivers are installed.** Easy to forget; skipping the removal will bite first boot.
- **BIOS** — P3.00 recommended (flash procedure: wiki `bios/flashing/`).
- **Power/thermal** — TDP **220W (~50W idle → 235W max)**; needs a **300W+ 12V PSU
  with an 8-pin PCIe** and a **high-static-pressure fan** (passive miner card). The
  community governors cut idle draw further.
- **Distro** — the wiki's default recommendation is actually **Fedora 43** (then
  Bazzite, CachyOS, Arch, Debian). We're going **CachyOS** to match the
  `bc250-toolkit`'s tested target — but Fedora 43 is a viable fallback if CachyOS
  headless proves painful (the wiki has a `fedora/` setup page).

## The runbook (who does what)

1. **You — CachyOS + Limine, minimal/headless.** CachyOS's tested target is the
   handheld edition (has a GUI); for a compute node we want **no desktop** (strip
   the DE / pick a minimal profile — TBD which CachyOS install path gives a clean
   headless base). Limine is required by the toolkit.
2. **You — community board setup** (interactive, run yourself; we don't wrap it):
   - `bc250-toolkit.sh` → Initial Setup + a Performance Profile (governors, swap).
   - `cu-live-manager` → unlock 24 → 40 CUs.
3. **Us — `bc250-node-bootstrap.sh`** (the LLMSpaghetti node layer; the only part we
   own). Then register the node on the core exactly like node1
   (`config/nodes.yaml` → this node's `url`).

## Our thin script — `bc250-node-bootstrap.sh` (spec)

A CachyOS/Arch (`pacman`) sibling of `node-bootstrap.sh`, carrying over the
fresh-install lessons. Installs **only** Ollama, LAN-exposed:

- **Ollama** — `pacman -S ollama` (or `ollama-bin` from the AUR / the official
  install script, whichever behaves on CachyOS — verify on hardware).
- **Ollama systemd drop-in** — `OLLAMA_HOST=0.0.0.0:11434`, `OLLAMA_MODELS=…`,
  `OLLAMA_KEEP_ALIVE=-1`. **`systemctl restart ollama`** after writing it (not
  `enable --now`), and **chown the models dir to the `ollama` user** — the two bugs
  the Ubuntu fresh install taught us (#29, #30).
- **GPU backend — Vulkan via Mesa RADV, CONFIRMED working.** The wiki documents
  Ollama+Vulkan inference on the board (up to 35B MoE), so our AMD-Vulkan path is
  right and ROCm isn't needed (no ROCm path documented). Requirements: Mesa + kernel
  in range (see [Version requirements](#version-requirements-bc-250-gpu)) + RADV env
  config (wiki `drivers/environment/`). The bootstrap should still **check Mesa +
  kernel and warn** (a bad version silently drops to CPU — the one failure a compute
  node can't have), and confirm `ollama ps` shows `100% GPU` on first run.
- **Optional `CORE_SSH_KEY`** — authorize the core to push installs over SSH (same
  hook as `node-bootstrap.sh`).
- Print the node IP + "register it on the core."

We do **not** duplicate the CU unlock, governors, or swap — the toolkit owns those.

## Open questions / to verify on hardware

- **RADV env config for compute** — the wiki's `drivers/environment/` page has RADV
  env vars; find which ones Ollama needs (e.g. forcing the right GPU / RADV options)
  and bake them into the Ollama systemd drop-in. (Ollama-Vulkan offload itself is
  already confirmed working — just get the env right.)
- **CachyOS headless install** — which install path yields a clean no-DE base for a
  compute node.
- **Ollama on CachyOS** — `pacman` package vs `ollama-bin` (AUR) vs the upstream
  install script; which respects a systemd drop-in cleanly.
- **CU-unlock persistence** — is the 24→40 unlock a boot-time step (does it survive
  reboot, or does the toolkit make it persistent)? Affects whether the node is
  reliably at 40 CUs when the core routes to it.
- **Does the GPU governor fight Ollama's load** (idle-downclock latency on the first
  token)? Measure.

## References

- **BC-250 wiki (authoritative):** <https://elektricm.github.io/amd-bc250-docs/>
  — key pages when building: `linux/cachyos/`, `linux/mesa/`, `linux/kernel/`,
  `drivers/radv/` + `drivers/environment/` (RADV env vars for compute),
  `system/40cu-unlock/`, `bios/vram/` + `bios/flashing/`, `governor/`.
- Reference "AI server" build: `akandr/bc250` (Ollama + Vulkan up to 35B MoE).
- Toolkit (governors/swap/profiles): <https://github.com/redbeard1083/bc250-toolkit>
- CU unlock 24→40: <https://github.com/WinnieLV/bc250-cu-live-manager>
- CPU governor: <https://github.com/bc250-collective/bc250_smu_oc>
- GPU governor: <https://github.com/filippor/cyan-skillfish-governor>
