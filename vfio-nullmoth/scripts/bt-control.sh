#!/usr/bin/env bash
set -euo pipefail

VM_DIR="/root/.local/share/reims-ctl/vms/mac"
QMP_SOCK="$VM_DIR/qmp.sock"
LOG_VFIO="$VM_DIR/logs/qemu_nullmoth_vfio.log"
DISABLE_FLAG="/root/.nullmoth_disable_bt"
BT_ID="usb-8087-0029"

if [ "$EUID" -ne 0 ]; then
  echo "[ERRO] Execute como root: sudo /root/bt-control.sh <status|attach|detach|preload-attach|enable|disable>"
  exit 1
fi

find_bt_sysfs() {
  local d vid pid
  for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] && [ -f "$d/idProduct" ] || continue
    vid=$(cat "$d/idVendor" 2>/dev/null || true)
    pid=$(cat "$d/idProduct" 2>/dev/null || true)
    if [ "$vid" = "8087" ] && [ "$pid" = "0029" ]; then
      echo "$d"
      return 0
    fi
  done
  return 1
}

qmp_hmp() {
  local cmd="$1"
  [ -S "$QMP_SOCK" ] || { echo "QMP_UNAVAILABLE"; return 1; }
  python3 - "$QMP_SOCK" "$cmd" << 'PY'
import json, socket, sys

sock_path, cmd = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3.0)
s.connect(sock_path)
f = s.makefile("rw")
f.readline()
f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n")
f.flush()
f.readline()
f.write(json.dumps({"execute": "human-monitor-command", "arguments": {"command-line": cmd}}) + "\n")
f.flush()
resp = json.loads(f.readline())
s.close()
if "error" in resp:
    print("QMP_ERROR:", resp["error"], file=sys.stderr)
    sys.exit(1)
print(resp.get("return", ""), end="")
PY
}

qmp_exec() {
  local payload="$1"
  [ -S "$QMP_SOCK" ] || { echo "QMP_UNAVAILABLE"; return 1; }
  python3 - "$QMP_SOCK" "$payload" << 'PY'
import json, socket, sys

sock_path, payload = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3.0)
s.connect(sock_path)
f = s.makefile("rw")
f.readline()
f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n")
f.flush()
f.readline()
f.write(payload + "\n")
f.flush()
resp = json.loads(f.readline())
s.close()
print(json.dumps(resp))
if "error" in resp:
    sys.exit(1)
PY
}

prepare_bt_host() {
  local dev="$1"
  local dev_name iface drv
  dev_name=$(basename "$dev")
  for iface in "${dev}/${dev_name}":*; do
    [ -e "$iface/driver/unbind" ] || continue
    drv=$(basename "$(readlink -f "$iface/driver" 2>/dev/null || true)" 2>/dev/null || true)
    if [ "$drv" = "btusb" ]; then
      basename "$iface" > "$iface/driver/unbind" 2>/dev/null || true
    fi
  done
  [ -w "$dev/avoid_reset_quirk" ] && echo 1 > "$dev/avoid_reset_quirk" 2>/dev/null || true
  [ -w "$dev/power/control" ] && echo on > "$dev/power/control" 2>/dev/null || true
}

cmd_status() {
  local dev mods usb_info err_cnt
  echo "=== Bluetooth 8087:0029 Host Status ==="
  echo "Disable flag ($DISABLE_FLAG): $([ -f "$DISABLE_FLAG" ] && echo 'YES (disabled)' || echo 'NO (enabled)')"
  if dev=$(find_bt_sysfs); then
    echo "Sysfs node: $dev"
    for attr in bcdDevice avoid_reset_quirk authorized power/control; do
      echo "  $attr = $(cat "$dev/$attr" 2>/dev/null || echo 'N/A')"
    done
    local dev_name iface drv
    dev_name=$(basename "$dev")
    for iface in "${dev}/${dev_name}":*; do
      [ -e "$iface" ] || continue
      if [ -L "$iface/driver" ]; then
        drv=$(basename "$(readlink -f "$iface/driver")")
      else
        drv="none"
      fi
      echo "  $(basename "$iface") driver = $drv"
    done
  else
    echo "Sysfs node: NOT FOUND (8087:0029 absent from USB bus)"
  fi

  mods=$(lsmod | awk '/^(btusb|btintel|btrtl|btbcm|bluetooth)[[:space:]]/{print $1}' | tr '\n' ' ' || true)
  echo "Loaded BT kernel modules: ${mods:-none}"

  if [ -S "$QMP_SOCK" ]; then
    echo "=== QEMU QMP 'info usb' ==="
    usb_info=$(qmp_hmp "info usb" 2>/dev/null || echo "QMP error")
    echo "${usb_info:-  (none)}"
  else
    echo "=== QEMU QMP: not running ($QMP_SOCK absent) ==="
  fi

  if [ -f "$LOG_VFIO" ]; then
    err_cnt=$(grep -c "libusb_set_interface_alt_setting" "$LOG_VFIO" 2>/dev/null || true)
    echo "libusb_set_interface_alt_setting errors in qemu_nullmoth_vfio.log: ${err_cnt:-0}"
  else
    echo "qemu_nullmoth_vfio.log: not present"
  fi
}

cmd_detach() {
  if [ ! -S "$QMP_SOCK" ]; then
    echo "QMP indisponivel ($QMP_SOCK); VM nao esta rodando."
    return 0
  fi
  local cur
  cur=$(qmp_hmp "info usb" 2>/dev/null || true)
  if ! echo "$cur" | grep -q "$BT_ID"; then
    echo "$BT_ID nao esta anexado na VM."
    return 0
  fi
  echo "Desanexando $BT_ID via QMP..."
  qmp_exec "{\"execute\":\"device_del\",\"arguments\":{\"id\":\"$BT_ID\"}}" >/dev/null || true
  sleep 2
  cur=$(qmp_hmp "info usb" 2>/dev/null || true)
  if echo "$cur" | grep -q "$BT_ID"; then
    echo "AVISO: $BT_ID ainda aparece em 'info usb' apos 2s:"
    echo "$cur"
    return 1
  fi
  echo "OK: $BT_ID removido da VM."
}

cmd_attach() {
  if [ -f "$DISABLE_FLAG" ]; then
    echo "[ERRO] Bluetooth desativado em $DISABLE_FLAG. Execute: sudo /root/bt-control.sh enable"
    return 1
  fi
  local dev auth cur
  dev=$(find_bt_sysfs) || { echo "[ERRO] Dispositivo 8087:0029 nao encontrado no barramento USB do host."; return 1; }
  auth=$(cat "$dev/authorized" 2>/dev/null || echo 0)
  if [ "$auth" != "1" ]; then
    echo "[ERRO] Dispositivo $dev com authorized=$auth."
    return 1
  fi
  if [ ! -S "$QMP_SOCK" ]; then
    echo "[ERRO] QMP indisponivel ($QMP_SOCK)."
    return 1
  fi
  cur=$(qmp_hmp "info usb" 2>/dev/null || true)
  if echo "$cur" | grep -q "$BT_ID"; then
    echo "$BT_ID ja esta anexado na VM:"
    echo "$cur"
    return 0
  fi
  prepare_bt_host "$dev"
  if lsmod | grep -q "^btusb[[:space:]]"; then
    modprobe -r btusb 2>/dev/null || true
  fi
  echo "Anexando $BT_ID ($dev) em xhci.0 port=3 (guest-reset=false, guest-resets-all=false)..."
  qmp_exec "{\"execute\":\"device_add\",\"arguments\":{\"driver\":\"usb-host\",\"id\":\"$BT_ID\",\"bus\":\"xhci.0\",\"port\":\"3\",\"vendorid\":32903,\"productid\":41,\"guest-reset\":false,\"guest-resets-all\":false}}"
  sleep 1
  qmp_hmp "info usb" || true
}

cmd_preload_attach() {
  if [ -f "$DISABLE_FLAG" ]; then
    echo "[ERRO] Bluetooth desativado em $DISABLE_FLAG. Execute: sudo /root/bt-control.sh enable"
    return 1
  fi
  local dev dev_name iface mark_ts i
  dev=$(find_bt_sysfs) || { echo "[ERRO] Dispositivo 8087:0029 nao encontrado no host."; return 1; }
  cmd_detach 2>/dev/null || true
  systemctl stop bluetooth.service 2>/dev/null || true

  mark_ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "Carregando btusb temporariamente no Linux para pre-carregar firmware (ibt-20-1-3.sfi)..."
  modprobe btusb
  for i in 1 2 3 4 5; do
    sleep 1
    if journalctl -k --since "$mark_ts" 2>/dev/null | grep -qiE "Firmware revision|Found device firmware|ibt-20|hci0|Bootloader revision"; then
      break
    fi
  done
  journalctl -k --since "$mark_ts" 2>/dev/null | grep -iE "bluetooth|btusb|btintel|ibt-|hci" || true

  if command -v hciconfig >/dev/null 2>&1; then
    hciconfig hci0 down 2>/dev/null || true
  fi
  dev_name=$(basename "$dev")
  for iface in "${dev}/${dev_name}":*; do
    [ -e "$iface/driver/unbind" ] && basename "$iface" > "$iface/driver/unbind" 2>/dev/null || true
  done
  modprobe -r btusb btintel bluetooth 2>/dev/null || modprobe -r btusb 2>/dev/null || true
  prepare_bt_host "$dev"
  cmd_attach
}

case "${1:-status}" in
  status)         cmd_status ;;
  detach)         cmd_detach ;;
  attach)         cmd_attach ;;
  preload-attach) cmd_preload_attach ;;
  disable)
    touch "$DISABLE_FLAG"
    echo "Criado $DISABLE_FLAG (Bluetooth sera omitido nos proximos boots)."
    cmd_detach 2>/dev/null || true
    ;;
  enable)
    rm -f "$DISABLE_FLAG"
    echo "Removido $DISABLE_FLAG (Bluetooth sera anexado nos proximos boots)."
    ;;
  *)
    echo "Uso: $0 <status|attach|detach|preload-attach|enable|disable>"
    exit 2
    ;;
esac
