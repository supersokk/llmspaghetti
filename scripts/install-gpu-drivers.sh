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

# ── NVIDIA CUDA ──────────────────────────────────────────────────────────────
install_cuda() {
  info "Installing NVIDIA CUDA drivers for Ubuntu $VERSION_ID..."

  if dpkg -l | grep -q "cuda-toolkit"; then
    success "CUDA already installed — skipping"
    return 0
  fi

  # NVIDIA keyring
  local KEYRING_URL="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu${UBUNTU_VER}/x86_64/cuda-keyring_1.1-1_all.deb"
  wget -qO /tmp/cuda-keyring.deb "$KEYRING_URL" || error "Failed to download CUDA keyring"
  dpkg -i /tmp/cuda-keyring.deb
  rm /tmp/cuda-keyring.deb
  apt-get update -qq

  # Install CUDA toolkit + open kernel modules (better compatibility)
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    cuda-toolkit \
    nvidia-kernel-open-dkms \
    cuda-drivers

  # Blacklist nouveau (open source NVIDIA driver that conflicts)
  cat > /etc/modprobe.d/blacklist-nouveau.conf << 'EOF'
blacklist nouveau
options nouveau modeset=0
EOF
  update-initramfs -u -k all 2>/dev/null || true

  # PATH for all users
  cat > /etc/profile.d/cuda.sh << 'EOF'
export PATH=/usr/local/cuda/bin${PATH:+:${PATH}}
export LD_LIBRARY_PATH=/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
EOF

  # Persist nvidia modules
  echo "nvidia" >> /etc/modules-load.d/llmspaghetti.conf
  echo "nvidia_uvm" >> /etc/modules-load.d/llmspaghetti.conf
  echo "nvidia_drm" >> /etc/modules-load.d/llmspaghetti.conf

  success "CUDA installed successfully (reboot required)"
  echo "CUDA" >> /opt/llmspaghetti/.needs-reboot
}

# ── AMD ROCm ─────────────────────────────────────────────────────────────────
install_rocm() {
  info "Installing AMD ROCm for Ubuntu $VERSION_ID..."

  if dpkg -l | grep -q "rocm-hip-sdk"; then
    success "ROCm already installed — skipping"
    return 0
  fi

  # AMD ROCm keyring + repo
  mkdir -p --mode=0755 /etc/apt/keyrings
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

# ── Main dispatch ─────────────────────────────────────────────────────────────
main() {
  info "Detected GPU stack: $GPU_VENDOR"

  case "$GPU_VENDOR" in
    cuda|cuda-pending)
      install_cuda
      ;;
    rocm|rocm-pending)
      install_rocm
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
      warn "Unknown GPU vendor '$GPU_VENDOR' — skipping driver install"
      ;;
  esac

  # Write GPU info to a file the rest of the stack can read
  mkdir -p /opt/llmspaghetti
  _gpu_detect_main --json > /opt/llmspaghetti/gpu-info.json
  success "GPU info written to /opt/llmspaghetti/gpu-info.json"
}

main "$@"
