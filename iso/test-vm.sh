#!/usr/bin/env bash
# =============================================================
# Test LLMSpaghetti ISO in QEMU from WSL2
# Requires: sudo apt install qemu-system-x86 qemu-utils
# =============================================================
ISO="${1:?Usage: bash test-vm.sh llmspaghetti-YYYYMMDD.iso}"
DISK="llmspaghetti-test-disk.qcow2"

if ! command -v qemu-system-x86_64 &>/dev/null; then
  echo "Installing QEMU..."
  sudo apt-get install -y qemu-system-x86 qemu-utils
fi

if [[ ! -f "$DISK" ]]; then
  echo "Creating 60GB test disk..."
  qemu-img create -f qcow2 "$DISK" 60G
fi

echo "Starting LLMSpaghetti VM..."
echo "The installer will run, then the VM will reboot into LLMSpaghetti."
echo "Open http://localhost:8080 in your browser to access the web UI."
echo ""

qemu-system-x86_64 \
  -m 4G \
  -smp 4 \
  -enable-kvm \
  -cpu host \
  -drive "file=$DISK,format=qcow2,if=virtio" \
  -cdrom "$ISO" \
  -boot order=dc \
  -net nic,model=virtio \
  -net user,hostfwd=tcp::8080-:80,hostfwd=tcp::9090-:9090 \
  -nographic
