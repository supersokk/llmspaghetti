# PLANNED — AMD BC-250 compute node (CachyOS)

**Status:** design only — **unverified until a board is in hand.** The BC-250 is a
niche path on purpose: it runs a *different distro* (CachyOS, not Ubuntu) because
that's where the community reverse-engineered the board. This doc writes down the
plan so it's ready; the actual `bc250-node-bootstrap.sh` gets written and tested on
real hardware. Fits the multi-node design ([PLANNED-multi-node.md](PLANNED-multi-node.md))
as node2/node3.

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
- **GPU backend — Vulkan via Mesa RADV** (our AMD-Vulkan path). The community
  confirms RADV drives the cyan-skillfish GPU **given a new-enough Mesa + kernel**
  (see [Version requirements](#version-requirements-bc-250-gpu) below), so this is
  the intended path — not the open question it first looked like. Remaining hardware
  verify: that **Ollama** actually offloads via Vulkan (`vulkaninfo` sees the GPU,
  `ollama ps` shows `100% GPU` on a request). If it doesn't, fall back to ROCm
  (heavier) or CPU. The bootstrap should **check Mesa + kernel versions and warn**
  before trusting the GPU (a bad version silently drops to CPU — the one failure a
  compute node can't have).
- **Optional `CORE_SSH_KEY`** — authorize the core to push installs over SSH (same
  hook as `node-bootstrap.sh`).
- Print the node IP + "register it on the core."

We do **not** duplicate the CU unlock, governors, or swap — the toolkit owns those.

## Open questions / to verify on hardware

- **Ollama GPU offload on cyan skillfish** — RADV/Vulkan is the intended path (with
  the Mesa + kernel versions above); confirm **Ollama** actually uses it (`ollama ps`
  → `100% GPU`), and that the CachyOS image's Mesa/kernel are in range. The whole
  point of the board; verify first.
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

- Toolkit: <https://github.com/redbeard1083/bc250-toolkit>
- CU unlock: <https://github.com/WinnieLV/bc250-cu-live-manager>
- CPU governor: <https://github.com/bc250-collective/bc250_smu_oc>
- GPU governor: <https://github.com/filippor/cyan-skillfish-governor>
