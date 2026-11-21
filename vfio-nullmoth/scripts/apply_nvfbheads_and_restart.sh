#!/usr/bin/env bash
set -euo pipefail

LOG="/root/nullmoth_apply_nvfbheads.log"
exec >"$LOG" 2>&1

on_err() {
  local ln="$1" rc="$2"
  trap - ERR
  set +e
  echo "[ERRO] Falha na linha $ln (rc=$rc); acionando /root/reverte-tudo.sh..."
  /root/reverte-tudo.sh || true
  exit 1
}
trap 'on_err $LINENO $?' ERR

echo "$(date): Aguardando 4s antes de parar a VM..."
sleep 4

echo "$(date): [1/3] Desligando VM VFIO atual limpa via QMP..."
python3 - << "PYEOF" || true
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
print("QMP system_powerdown sent")
PYEOF

for i in $(seq 1 20); do
  [ -z "$(pidof qemu-system-x86_64 || true)" ] && break
  sleep 1
done

PIDS=$(pidof qemu-system-x86_64 || true)
if [ -n "$PIDS" ]; then
  echo "QEMU ainda rodando ($PIDS); enviando SIGTERM..."
  kill -TERM $PIDS 2>/dev/null || true
  sleep 3
fi
PIDS=$(pidof qemu-system-x86_64 || true)
if [ -n "$PIDS" ]; then
  echo "Forcando SIGKILL em $PIDS..."
  kill -9 $PIDS 2>/dev/null || true
  sleep 2
fi
[ -z "$(pidof qemu-system-x86_64 || true)" ] || { echo "[ERRO] QEMU nao parou!"; exit 1; }

echo "$(date): [2/3] Adicionando nvfbheads=4 em opencore_nullmoth.qcow2..."
modprobe nbd max_part=8
NBD=""
for dev in /dev/nbd{0..15}; do
  bname=$(basename "$dev")
  if [ ! -e "/sys/block/$bname/pid" ] && [ "$(blockdev --getsize64 "$dev" 2>/dev/null || echo 1)" -eq 0 ]; then
    NBD="$dev"
    break
  fi
done
[ -n "$NBD" ] || { echo "[ERRO] Nenhum /dev/nbd livre"; exit 1; }
MNT=$(mktemp -d /tmp/oc_heads_mnt.XXXXXX)
cleanup_nbd() {
  sync || true
  if mountpoint -q "$MNT"; then umount "$MNT" || true; fi
  rmdir "$MNT" 2>/dev/null || true
  if [ -n "${NBD:-}" ]; then qemu-nbd -d "$NBD" >/dev/null 2>&1 || true; fi
}
trap 'cleanup_nbd; on_err $LINENO $?' ERR

OC_NM="/root/.local/share/reims-ctl/vms/mac/opencore_nullmoth.qcow2"
qemu-nbd -c "$NBD" "$OC_NM"
for i in $(seq 1 20); do [ -b "${NBD}p1" ] && break; partprobe "$NBD" >/dev/null 2>&1 || true; sleep 0.2; done
[ -b "${NBD}p1" ] || { echo "[ERRO] ${NBD}p1 nao encontrado"; exit 1; }
mount "${NBD}p1" "$MNT"

python3 - "$MNT/EFI/OC/config.plist" << "PYEOF"
import plistlib, sys
p = sys.argv[1]
with open(p, "rb") as f:
    cfg = plistlib.load(f)
guid = "7C436110-AB2A-4BBB-A880-FE41995C9F82"
ba = cfg["NVRAM"]["Add"][guid]["boot-args"]
if "nvfbheads=" not in ba:
    ba = ba.replace("nvaccel=1", "nvaccel=1 nvfbheads=4", 1)
    cfg["NVRAM"]["Add"][guid]["boot-args"] = ba
    with open(p, "wb") as f:
        plistlib.dump(cfg, f, sort_keys=False)
with open(p, "rb") as f:
    v = plistlib.load(f)
got = v["NVRAM"]["Add"][guid]["boot-args"]
assert "nvfbheads=4" in got, f"Missing nvfbheads=4: {got!r}"
print("UPDATED boot-args:", got)
PYEOF

cleanup_nbd
NBD=""
trap 'on_err $LINENO $?' ERR

qemu-img check "$OC_NM"

echo "$(date): [3/3] Iniciando VM VFIO otimizada (8 vCPUs pinned, 12 GB RAM, nvfbheads=4)..."
/root/iniciar-nullmoth-vfio.sh >/root/nullmoth_vfio_launch.log 2>&1
echo "$(date): CONCLUIDO!"
