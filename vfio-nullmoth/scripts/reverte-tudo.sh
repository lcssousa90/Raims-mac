#!/usr/bin/env bash
set -uo pipefail
BACKUP="/root/backup_golden_20261119_v2_818868564"
VM_DIR="/root/.local/share/reims-ctl/vms/mac"

echo "==> [1/4] Parando watchdog, limpando flags VFIO e encerrando QEMU de teste..."
rm -f /root/.nullmoth_vfio_default /root/.boot_nullmoth_vfio
if [ -f /tmp/nullmoth_watchdog.pid ]; then
  WD_PID=$(cat /tmp/nullmoth_watchdog.pid 2>/dev/null || true)
  [ -n "$WD_PID" ] && [ "$WD_PID" != "$$" ] && kill "$WD_PID" 2>/dev/null || true
  rm -f /tmp/nullmoth_watchdog.pid
fi
/root/bt-control.sh detach 2>/dev/null || true
/root/.cargo/bin/reims-ctl stop mac --force 2>/dev/null || true
QEMU_PIDS=$(pidof qemu-system-x86_64 2>/dev/null || true)
[ -n "$QEMU_PIDS" ] && kill -9 $QEMU_PIDS 2>/dev/null || true
sleep 2

echo 0 > /proc/sys/vm/nr_hugepages 2>/dev/null || true

echo "==> [2/4] Devolvendo RTX 3070 (07:00.0/07:00.1) e USB (09:00.3) para o Linux..."
echo "10de 2484" > /sys/bus/pci/drivers/vfio-pci/remove_id 2>/dev/null || true
echo "10de 228b" > /sys/bus/pci/drivers/vfio-pci/remove_id 2>/dev/null || true
for dev in 0000:07:00.0 0000:07:00.1 0000:09:00.3; do
  if [ -e "/sys/bus/pci/drivers/vfio-pci/$dev" ]; then
    echo "$dev" > /sys/bus/pci/drivers/vfio-pci/unbind 2>/dev/null || true
  fi
  [ -e "/sys/bus/pci/devices/$dev/driver_override" ] && echo "" > "/sys/bus/pci/devices/$dev/driver_override" 2>/dev/null || true
done
modprobe nvidia 2>/dev/null || true
modprobe nvidia_modeset 2>/dev/null || true
modprobe nvidia_drm 2>/dev/null || true
modprobe nvidia_uvm 2>/dev/null || true
modprobe snd_hda_intel 2>/dev/null || true
modprobe xhci_pci 2>/dev/null || true
echo 1 > /sys/bus/pci/drivers_autoprobe 2>/dev/null || true
for dev in 0000:07:00.0 0000:07:00.1 0000:09:00.3; do
  echo "$dev" > /sys/bus/pci/drivers_probe 2>/dev/null || true
done
for vt in /sys/class/vtconsole/vtcon*; do
  [ -e "$vt/bind" ] && echo 1 > "$vt/bind" 2>/dev/null || true
done
systemctl start nvidia-persistenced.service 2>/dev/null || true
[ -x /usr/local/bin/reims-hardware-tune.sh ] && /usr/local/bin/reims-hardware-tune.sh 2>/dev/null || true

echo "==> [3/4] Restaurando arquivos de backup (opencore.qcow2, OVMF_VARS.fd, vm.toml, .xinitrc, QEMU)..."
cp -a "$BACKUP/opencore.qcow2" "$VM_DIR/opencore.qcow2"
cp -a "$BACKUP/OVMF_VARS.fd" "$VM_DIR/OVMF_VARS.fd"
cp -a "$BACKUP/vm.toml" "$VM_DIR/vm.toml"
cp -a "$BACKUP/.xinitrc" /root/.xinitrc
if [ -f "$BACKUP/qemu_current_target.txt" ]; then
  ln -sfn "$(cat "$BACKUP/qemu_current_target.txt")" /root/.local/share/reims-ctl/qemu/current
fi
sync

echo "==> [4/4] Reiniciando sessao grafica e VM com reims-vgpu..."
if pgrep -x Xorg >/dev/null 2>&1; then
  XDG_RUNTIME_DIR=/run/user/1000 DISPLAY=:0 XAUTHORITY=/root/.Xauthority /root/.cargo/bin/reims-ctl start mac &
else
  systemctl restart getty@tty1.service 2>/dev/null || true
fi
echo "==> Reversao concluida!"
