#!/usr/bin/env bash
# Install ISO build dependencies on WSL2 / Ubuntu
set -e
echo "Installing LLMSpaghetti ISO build dependencies..."
apt-get update -qq
apt-get install -y \
  xorriso squashfs-tools \
  grub-efi-amd64-bin grub-pc-bin \
  mtools dosfstools \
  rsync curl wget
echo "Done. You can now run: bash iso/build.sh"
