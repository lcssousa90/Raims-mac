#!/usr/bin/env bash
set -euo pipefail

QCOW2="/root/.local/share/reims-ctl/vms/mac/disk.qcow2"
EFI_SRC="/root/EFI_BAREMETAL_READY/EFI"
[ -d "$EFI_SRC" ] || EFI_SRC="/root/Raims-mac/hackintosh-baremetal/EFI"

usage() {
  cat << 'USAGE'
Uso:
  1) Clonar apenas o container APFS do macOS para uma PARTICAO fisica (Dual/Triple-Boot no mesmo SSD):
     sudo ./clonar-vm-para-disco-fisico.sh --particao /dev/nvme0n1p6 [--efi-part /dev/nvme0n1p1]

  2) Clonar o disco inteiro da VM (GPT + EFI + APFS) para um DISCO fisico dedicado (APAGA O DISCO ALVO):
     sudo ./clonar-vm-para-disco-fisico.sh --disco-inteiro /dev/sdX

  3) Apenas copiar a pasta EFI Bare-Metal pronta para um pendrive (FAT32) para testar o boot:
     sudo ./clonar-vm-para-disco-fisico.sh --instalar-efi /dev/sdY1
USAGE
  exit 1
}

[ "$EUID" -eq 0 ] || { echo "[ERRO] Execute como root (sudo)."; exit 1; }
[ $# -ge 2 ] || usage

MODE="$1"
TARGET="$2"
EFI_PART="${4:-}"

stop_vm_if_running() {
  if pidof qemu-system-x86_64 >/dev/null 2>&1; then
    echo "[!] A VM macOS esta rodando. Parando a VM de forma limpa via QMP antes de acessar o disk.qcow2..."
    python3 - << 'PYEOF' || true
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3)
s.connect("/root/.local/share/reims-ctl/vms/mac/qmp.sock")
f = s.makefile("r")
f.readline()
s.sendall(json.dumps({"execute": "qmp_capabilities"}).encode() + b"\n")
f.readline()
s.sendall(json.dumps({"execute": "system_powerdown"}).encode() + b"\n")
f.readline()
s.close()
PYEOF
    for _ in $(seq 1 30); do
      pidof qemu-system-x86_64 >/dev/null 2>&1 || break
      sleep 1
    done
    if pidof qemu-system-x86_64 >/dev/null 2>&1; then
      kill -TERM $(pidof qemu-system-x86_64) 2>/dev/null || true
      sleep 3
    fi
  fi
}

install_efi_to_part() {
  local epart="$1"
  [ -b "$epart" ] || { echo "[ERRO] Particao EFI $epart nao existe."; exit 1; }
  local mnt
  mnt=$(mktemp -d /tmp/efi_target.XXXXXX)
  mount "$epart" "$mnt"
  if [ -d "$mnt/EFI/OC" ]; then
    local bak="$mnt/EFI/OC.bak_$(date +%Y%m%d_%H%M%S)"
    echo "    Fazendo backup de $mnt/EFI/OC em $bak..."
    mv "$mnt/EFI/OC" "$bak"
  fi
  mkdir -p "$mnt/EFI"
  cp -r "$EFI_SRC/OC" "$mnt/EFI/"
  mkdir -p "$mnt/EFI/BOOT"
  cp -f "$EFI_SRC/BOOT/BOOTx64.efi" "$mnt/EFI/BOOT/OpenCore.efi"
  if [ ! -f "$mnt/EFI/BOOT/BOOTx64.efi" ]; then
    cp -f "$EFI_SRC/BOOT/BOOTx64.efi" "$mnt/EFI/BOOT/BOOTx64.efi"
  fi
  sync
  umount "$mnt"
  rmdir "$mnt"
  echo "    [OK] EFI Bare-Metal instalada em $epart!"
}

case "$MODE" in
  --instalar-efi)
    echo "==> Instalando EFI Bare-Metal ($EFI_SRC) na particao $TARGET..."
    install_efi_to_part "$TARGET"
    ;;

  --particao)
    [ -b "$TARGET" ] || { echo "[ERRO] Particao destino $TARGET nao encontrada."; exit 1; }
    PART_SIZE=$(blockdev --getsize64 "$TARGET")
    MIN_SIZE=$((127 * 1024 * 1024 * 1024))
    if [ "$PART_SIZE" -lt "$MIN_SIZE" ]; then
      echo "[ERRO] A particao $TARGET tem $((PART_SIZE / 1024 / 1024 / 1024)) GiB, mas o container APFS da VM precisa de pelo menos 128 GiB."
      exit 1
    fi
    stop_vm_if_running
    modprobe nbd max_part=8
    qemu-nbd -r -c /dev/nbd15 "$QCOW2"
    trap 'qemu-nbd -d /dev/nbd15 >/dev/null 2>&1 || true' EXIT
    for _ in $(seq 1 20); do [ -b /dev/nbd15p2 ] && break; partprobe /dev/nbd15 2>/dev/null || true; sleep 0.2; done
    [ -b /dev/nbd15p2 ] || { echo "[ERRO] Particao APFS (/dev/nbd15p2) nao encontrada dentro de $QCOW2."; exit 1; }
    echo "==> Clonando container APFS (/dev/nbd15p2 -> $TARGET)..."
    dd if=/dev/nbd15p2 of="$TARGET" bs=16M status=progress conv=fsync
    qemu-nbd -d /dev/nbd15
    trap - EXIT
    echo "==> [OK] Container APFS clonado com sucesso para $TARGET!"
    if [ -n "$EFI_PART" ]; then
      install_efi_to_part "$EFI_PART"
    fi
    ;;

  --disco-inteiro)
    [ -b "$TARGET" ] || { echo "[ERRO] Disco destino $TARGET nao encontrado."; exit 1; }
    stop_vm_if_running
    echo "==> Convertendo $QCOW2 diretamente para o disco fisico $TARGET..."
    qemu-img convert -p -f qcow2 -O raw "$QCOW2" "$TARGET"
    sync
    partprobe "$TARGET" 2>/dev/null || true
    command -v sgdisk >/dev/null 2>&1 && sgdisk -e "$TARGET" || true
    partprobe "$TARGET" 2>/dev/null || true
    sleep 1
    if [[ "$TARGET" == *nvme* ]] || [[ "$TARGET" == *mmcblk* ]]; then
      EP="${TARGET}p1"
    else
      EP="${TARGET}1"
    fi
    if [ -b "$EP" ]; then
      install_efi_to_part "$EP"
    fi
    echo "==> [OK] Disco $TARGET pronto para boot Bare-Metal no macOS!"
    ;;

  *)
    usage
    ;;
esac
