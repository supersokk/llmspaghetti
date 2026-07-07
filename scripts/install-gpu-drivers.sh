#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti GPU Driver Installer
# Called by bootstrap.sh after gpu-detect.sh identifies the hardware.
# Safe to re-run — skips already-installed drivers.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/gpu-detect.sh"

# Run detection (sets GPU_VENDOR etc.)
_gpu_detect_main

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[GPU]${RESET}  $*"; }
success() { echo -e "${GREEN}[GPU]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}[GPU]${RESET}  $*"; }
error()   { echo -e "${RED}[GPU]${RESET}  $*" >&2; exit 1; }

. /etc/os-release
UBUNTU_VER="${VERSION_ID//./}"   # e.g. 2404

# ── NVIDIA driver ────────────────────────────────────────────────────────────
# Ollama bundles its own CUDA runtime — it only needs the NVIDIA *driver*, not
# the full CUDA toolkit. We install via Ubuntu's `ubuntu-drivers`, which uses
# prebuilt kernel modules matched to the running kernel + release. That's far
# more robust than NVIDIA's DKMS repo packages, and it works on brand-new Ubuntu
# releases before NVIDIA publishes a matching CUDA repo.
#
# (Verified on Ubuntu 26.04 + RTX 2060 Super, 2026-06-27. The old approach —
#  cuda-toolkit + nvidia-kernel-open-dkms from NVIDIA's repo — failed because
#  nvidia-kernel-open-dkms had no 26.04 candidate, which aborted the whole
#  apt install. See docs/INSTALL.md.)
#
# The CUDA *toolkit* (nvcc etc.) is only needed for optional runtimes like vLLM;
# install that separately if/when you enable them.
install_cuda() {
  info "Installing NVIDIA driver for Ubuntu $VERSION_ID (via ubuntu-drivers)..."

  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
    success "NVIDIA driver already active — skipping"
    return 0
  fi

  apt-get install -y -qq ubuntu-drivers-common 2>/dev/null || true

  if command -v ubuntu-drivers &>/dev/null && ubuntu-drivers install; then
    success "NVIDIA driver installed via ubuntu-drivers"
  else
    warn "ubuntu-drivers install failed — trying an explicit -open driver"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-driver-580-open \
      || error "Could not install an NVIDIA driver. Try manually: sudo ubuntu-drivers install"
  fi

  echo "NVIDIA driver" >> /opt/llmspaghetti/.needs-reboot
  success "NVIDIA driver installed (reboot required)"
}

# ── AMD ROCm ─────────────────────────────────────────────────────────────────
install_rocm() {
  info "Installing AMD ROCm for Ubuntu $VERSION_ID..."

  if dpkg -l | grep -q "rocm-hip-sdk"; then
    success "ROCm already installed — skipping"
    return 0
  fi

  # AMD ROCm keyring + repo
  mkdir -p /etc/apt/keyrings && chmod 0755 /etc/apt/keyrings
  wget -qO /etc/apt/keyrings/rocm.gpg \
    https://repo.radeon.com/rocm/rocm.gpg.key || error "Failed to download ROCm GPG key"

  # Use the appropriate ROCm repo for the Ubuntu version
  local ROCM_REPO="https://repo.radeon.com/rocm/apt/6.0"
  cat > /etc/apt/sources.list.d/rocm.list << EOF
deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] ${ROCM_REPO} $(lsb_release -cs) main
EOF

  # Add AMDGPU repo for kernel driver
  wget -qO /etc/apt/keyrings/amdgpu.gpg \
    https://repo.radeon.com/amdgpu/latest/ubuntu/ubuntu/pool/main/a/amdgpu-install/amdgpu-install.gpg 2>/dev/null || true

  apt-get update -qq

  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    rocm-hip-sdk \
    rocm-opencl-sdk \
    rocm-dev \
    hipblaslt

  # Add render group for GPU access without root
  grep -q "^render:" /etc/group && usermod -aG render llmspaghetti 2>/dev/null || true
  usermod -aG video llmspaghetti 2>/dev/null || true

  cat > /etc/profile.d/rocm.sh << 'EOF'
export PATH=/opt/rocm/bin:/opt/rocm/llvm/bin${PATH:+:${PATH}}
export LD_LIBRARY_PATH=/opt/rocm/lib:/opt/rocm/lib64${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
export HSA_OVERRIDE_GFX_VERSION=11.0.0   # helps with newer AMD cards
EOF

  success "ROCm installed successfully (reboot required)"
  echo "ROCm" >> /opt/llmspaghetti/.needs-reboot
}

install_vulkan() {
  # The default AMD path: lightweight Mesa Vulkan (RADV). Works on the widest
  # range of Radeon cards out of the box and is what Ollama uses by default.
  # ROCm stays an opt-in upgrade (Cockpit → Services) for cards that support it.
  info "Installing Mesa Vulkan drivers for AMD (broad-compat, lightweight)..."

  if command -v vulkaninfo &>/dev/null && vulkaninfo --summary &>/dev/null; then
    success "Vulkan already available — skipping driver install"
  else
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      mesa-vulkan-drivers \
      libvulkan1 \
      vulkan-tools \
      || warn "Vulkan driver install had issues — Ollama may fall back to CPU"
  fi

  # Ollama runs as the `ollama` service user — that's the account that opens
  # /dev/dri/* for Vulkan, so it needs render+video group membership.
  for u in ollama llmspaghetti; do
    id "$u" &>/dev/null || continue
    grep -q "^render:" /etc/group && usermod -aG render "$u" 2>/dev/null || true
    usermod -aG video "$u" 2>/dev/null || true
  done
  # Group changes only apply to new processes — restart Ollama if it's running.
  systemctl is-active --quiet ollama 2>/dev/null && systemctl restart ollama 2>/dev/null || true

  success "Vulkan (Mesa RADV) ready — Ollama will use the AMD GPU automatically"
  info  "Card supports ROCm? Install it later from Cockpit → Services for more speed."
}

# ── Main dispatch ─────────────────────────────────────────────────────────────
# Usage: install-gpu-drivers.sh [target]
#   target defaults to the auto-detected GPU_VENDOR. Pass an explicit target
#   (e.g. "rocm") to force a specific stack — the Cockpit Services tab uses
#   `install-gpu-drivers.sh rocm` to offer ROCm as an opt-in upgrade on top of
#   the default Vulkan path.
main() {
  local target="${1:-$GPU_VENDOR}"
  info "GPU stack: detected=$GPU_VENDOR, installing=$target"

  case "$target" in
    cuda|cuda-pending)
      install_cuda
      ;;
    rocm|rocm-pending)
      install_rocm
      ;;
    vulkan)
      install_vulkan
      ;;
    cuda+rocm)
      install_cuda
      install_rocm
      ;;
    none)
      warn "No GPU detected — skipping driver install (CPU inference only)"
      warn "You can re-run this script after adding a GPU"
      ;;
    *)
      warn "Unknown GPU target '$target' — skipping driver install"
      ;;
  esac

  # Write GPU info to a file the rest of the stack can read
  mkdir -p /opt/llmspaghetti
  _gpu_detect_main --json > /opt/llmspaghetti/gpu-info.json
  success "GPU info written to /opt/llmspaghetti/gpu-info.json"
}

main "$@"
