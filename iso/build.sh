#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti ISO Builder
# Builds a bootable LLMSpaghetti ISO from WSL2 (or any Linux).
# The resulting ISO installs silently and boots into the LLMSpaghetti console.
#
# Prerequisites (run install-build-deps.sh first):
#   apt install xorriso squashfs-tools grub-efi-amd64-bin mtools curl
#
# Usage:
#   bash build.sh [--ubuntu-version 24.04] [--output llmspaghetti.iso]
# =============================================================================

set -euo pipefail

UBUNTU_VERSION="${UBUNTU_VERSION:-24.04}"
OUTPUT="${OUTPUT:-llmspaghetti-$(date +%Y%m%d).iso}"
WORK_DIR="/tmp/llmspaghetti-build"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

step()    { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${RESET}"; }
info()    { echo -e "  ${CYAN}▸${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "  ${RED}✗${RESET}  $*" >&2; exit 1; }

for arg in "$@"; do
  case $arg in
    --ubuntu-version=*) UBUNTU_VERSION="${arg#*=}" ;;
    --output=*)         OUTPUT="${arg#*=}" ;;
  esac
done

# ── Check build deps ──────────────────────────────────────────────────────────
step "Checking build dependencies"
missing=()
for cmd in xorriso mksquashfs grub-mkstandalone curl wget; do
  command -v "$cmd" &>/dev/null || missing+=("$cmd")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  error "Missing tools: ${missing[*]}\nRun: sudo bash install-build-deps.sh"
fi
success "All build tools present"

# ── Download base Ubuntu Server ISO ──────────────────────────────────────────
step "Obtaining Ubuntu $UBUNTU_VERSION Server ISO"

UBUNTU_SHORT="${UBUNTU_VERSION//./}"   # 24.04 → 2404
ISO_NAME="ubuntu-${UBUNTU_VERSION}-live-server-amd64.iso"
ISO_URL="https://releases.ubuntu.com/${UBUNTU_VERSION}/${ISO_NAME}"
ISO_CACHE="$SCRIPT_DIR/cache/${ISO_NAME}"

mkdir -p "$SCRIPT_DIR/cache"

if [[ -f "$ISO_CACHE" ]]; then
  success "Using cached ISO: $ISO_CACHE"
else
  info "Downloading $ISO_NAME (~2GB)..."
  wget -q --show-progress -O "$ISO_CACHE" "$ISO_URL" || \
    error "Download failed. Check your internet connection."
  success "Downloaded"
fi

# ── Extract ISO ───────────────────────────────────────────────────────────────
step "Extracting source ISO"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/source-files"

# Mount ISO and copy contents
LOOP_DEV=$(losetup -f)
losetup -r "$LOOP_DEV" "$ISO_CACHE"
MOUNT_POINT="/mnt/llmspaghetti-iso-$$"
mkdir -p "$MOUNT_POINT"
mount -o ro "$LOOP_DEV" "$MOUNT_POINT"

# Copy all ISO content (rsync preserves permissions)
rsync -a --exclude=/casper/filesystem.squashfs "$MOUNT_POINT/" "$WORK_DIR/source-files/"

umount "$MOUNT_POINT"
losetup -d "$LOOP_DEV"
rmdir "$MOUNT_POINT"
success "ISO extracted"

# ── Extract and modify squashfs (the root filesystem) ────────────────────────
step "Modifying root filesystem"

SQUASHFS_SRC=$(ls "$WORK_DIR/source-files/casper/"*.squashfs | head -1)
ROOTFS="$WORK_DIR/rootfs"

info "Extracting squashfs ($SQUASHFS_SRC)..."
unsquashfs -d "$ROOTFS" "$SQUASHFS_SRC"

# Remove unnecessary packages to slim the image
info "Slimming rootfs..."
chroot "$ROOTFS" /bin/bash << 'CHROOT'
export DEBIAN_FRONTEND=noninteractive
# Remove desktop/snap cruft not needed for headless
apt-get remove -y --purge snapd cloud-init ubuntu-advantage-tools 2>/dev/null || true
apt-get autoremove -y --purge 2>/dev/null || true
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /tmp/* /var/tmp/*
CHROOT

# ── Bake in LLMSpaghetti files ───────────────────────────────────────────────────────
step "Baking LLMSpaghetti into rootfs"

# Create directory structure
mkdir -p "$ROOTFS/opt/llmspaghetti/"{config,logs,scripts,data/webui}
mkdir -p "$ROOTFS/opt/llmspaghetti/console"
mkdir -p "$ROOTFS/opt/llmspaghetti/firstboot/templates"
mkdir -p "$ROOTFS/opt/llmspaghetti/firstboot/static"

# Copy all LLMSpaghetti files
cp -r "$REPO_DIR/console/."     "$ROOTFS/opt/llmspaghetti/console/"
cp -r "$REPO_DIR/firstboot/."   "$ROOTFS/opt/llmspaghetti/firstboot/"
cp -r "$REPO_DIR/stack/."       "$ROOTFS/opt/llmspaghetti/"
cp    "$REPO_DIR/scripts/bootstrap.sh"           "$ROOTFS/opt/llmspaghetti/scripts/"
cp    "$REPO_DIR/scripts/gpu-detect.sh"          "$ROOTFS/opt/llmspaghetti/scripts/"
cp    "$REPO_DIR/scripts/install-gpu-drivers.sh" "$ROOTFS/opt/llmspaghetti/scripts/"
cp    "$REPO_DIR/scripts/spag-cli.sh"           "$ROOTFS/usr/local/bin/spag"
cp    "$REPO_DIR/scripts/llmspaghetti-watchdog.sh"      "$ROOTFS/usr/local/bin/llmspaghetti-watchdog"
chmod +x "$ROOTFS/usr/local/bin/spag" "$ROOTFS/usr/local/bin/llmspaghetti-watchdog"

# Copy systemd services
cp "$REPO_DIR/services"/*.service "$ROOTFS/etc/systemd/system/"

success "LLMSpaghetti files baked in"

# ── Pre-install base packages in rootfs (speeds up first boot) ───────────────
step "Pre-installing packages in rootfs"

# Bind mounts needed for apt in chroot
mount --bind /proc "$ROOTFS/proc"
mount --bind /sys  "$ROOTFS/sys"
mount --bind /dev  "$ROOTFS/dev"
mount --bind /run  "$ROOTFS/run"

chroot "$ROOTFS" /bin/bash << 'CHROOT'
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq \
  curl wget git jq pciutils \
  python3 python3-pip \
  net-tools iproute2 htop nvtop \
  cockpit cockpit-storaged \
  ca-certificates gnupg

# Python deps for first-boot wizard
pip3 install -q fastapi uvicorn jinja2 python-multipart 2>/dev/null || true

# Pre-install Caddy
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor > /etc/apt/keyrings/caddy-stable.gpg
echo "deb [signed-by=/etc/apt/keyrings/caddy-stable.gpg] \
  https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq && apt-get install -y -qq caddy

# Pre-install Docker (just the repo; actual daemon starts post-install)
curl -fsSL https://get.docker.com | sh

# Pre-install Ollama binary
curl -fsSL https://ollama.com/install.sh | sh

# Enable services
systemctl enable llmspaghetti-firstboot.service
systemctl enable llmspaghetti-status.service
systemctl enable llmspaghetti-watchdog.service
systemctl enable cockpit.socket
systemctl enable caddy
systemctl enable docker
systemctl enable ollama
systemctl disable getty@tty1.service 2>/dev/null || true
systemctl mask    getty@tty1.service 2>/dev/null || true

apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
CHROOT

# Unmount bind mounts
umount "$ROOTFS/proc" "$ROOTFS/sys" "$ROOTFS/dev" "$ROOTFS/run"

success "Packages pre-installed"

# ── Bake in autoinstall config ────────────────────────────────────────────────
step "Adding autoinstall config"

mkdir -p "$WORK_DIR/source-files/autoinstall"
cp "$SCRIPT_DIR/../iso/autoinstall/user-data" "$WORK_DIR/source-files/autoinstall/"
cp "$SCRIPT_DIR/../iso/autoinstall/meta-data"  "$WORK_DIR/source-files/autoinstall/"

# GRUB: boot with autoinstall pointing at our config
cat > "$WORK_DIR/source-files/boot/grub/grub.cfg" << 'GRUBCFG'
set default=0
set timeout=5

menuentry "Install LLMSpaghetti" --id=llmspaghetti-install {
    set gfxpayload=keep
    linux   /casper/vmlinuz quiet autoinstall ds=nocloud\;seedfrom=/cdrom/autoinstall/ ---
    initrd  /casper/initrd
}

menuentry "Install LLMSpaghetti (verbose)" --id=llmspaghetti-install-verbose {
    linux   /casper/vmlinuz autoinstall ds=nocloud\;seedfrom=/cdrom/autoinstall/ ---
    initrd  /casper/initrd
}
GRUBCFG

success "Autoinstall config added"

# ── Repack squashfs ───────────────────────────────────────────────────────────
step "Repacking squashfs (this takes a few minutes...)"

mksquashfs "$ROOTFS" "$WORK_DIR/source-files/casper/filesystem.squashfs" \
  -comp xz -Xbcj x86 -b 1M -noappend -no-progress

# Update filesystem size manifest
printf $(du -sx --block-size=1 "$ROOTFS" | cut -f1) > \
  "$WORK_DIR/source-files/casper/filesystem.size"

success "Squashfs repacked"

# ── Build final ISO ───────────────────────────────────────────────────────────
step "Building ISO"

xorriso -as mkisofs \
  -r -V "LLMSpaghetti" \
  -o "$OUTPUT" \
  --grub2-mbr "$WORK_DIR/source-files/boot/grub/i386-pc/boot_hybrid.img" \
  -partition_offset 16 \
  --mbr-force-bootable \
  -append_partition 2 28732ac11ff8d211ba4b00a0c93ec93b \
    "$WORK_DIR/source-files/boot/grub/efi.img" \
  -appended_part_as_gpt \
  -iso_mbr_part_type a2a0d0ebe5b9334487c068b6b72699c7 \
  -c '/boot/boot.cat' \
  -b '/boot/grub/i386-pc/eltorito.img' \
  -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
  -eltorito-alt-boot \
  -e '--interval:appended_partition_2:::' \
  -no-emul-boot \
  "$WORK_DIR/source-files"

# ── Cleanup ───────────────────────────────────────────────────────────────────
step "Cleanup"
rm -rf "$WORK_DIR"
success "Build directory cleaned"

# ── Done ──────────────────────────────────────────────────────────────────────
ISO_SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo ""
echo -e "${BOLD}${GREEN}┌──────────────────────────────────────────────┐${RESET}"
echo -e "${BOLD}${GREEN}│         LLMSpaghetti ISO Built Successfully!        │${RESET}"
echo -e "${BOLD}${GREEN}└──────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  Output : ${CYAN}$OUTPUT${RESET}  (${ISO_SIZE})"
echo ""
echo -e "  ${BOLD}Flash to USB:${RESET}"
echo -e "    Linux:   sudo dd if=$OUTPUT of=/dev/sdX bs=4M status=progress"
echo -e "    Windows: Use Rufus (dd mode, NOT ISO mode)"
echo ""
echo -e "  ${BOLD}Test in QEMU (WSL2):${RESET}"
echo -e "    bash test-vm.sh $OUTPUT"
echo ""
