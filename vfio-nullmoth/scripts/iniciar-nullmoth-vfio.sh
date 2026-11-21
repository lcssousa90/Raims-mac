#!/usr/bin/env bash
set -euo pipefail

VM_DIR="/root/.local/share/reims-ctl/vms/mac"
QEMU_BIN="/root/.local/share/reims-ctl/qemu/current/bin/qemu-system-x86_64"
if [ -f "$VM_DIR/opencore_nullmoth_bt_v2.qcow2" ] && [ ! -f /root/.nullmoth_disable_bt ]; then
  OC_NM="$VM_DIR/opencore_nullmoth_bt_v2.qcow2"
elif [ -f "$VM_DIR/opencore_nullmoth_bt.qcow2" ] && [ ! -f /root/.nullmoth_disable_bt ]; then
  OC_NM="$VM_DIR/opencore_nullmoth_bt.qcow2"
else
  OC_NM="$VM_DIR/opencore_nullmoth.qcow2"
fi
if [ -f /var/lib/mothos/selected_opencore ]; then
  MOTHOS_SELECTED_OC=$(tr -d '\r\n' < /var/lib/mothos/selected_opencore)
  if [ -n "$MOTHOS_SELECTED_OC" ] && [[ "$MOTHOS_SELECTED_OC" != */* ]] && [ -f "$VM_DIR/$MOTHOS_SELECTED_OC" ]; then
    OC_NM="$VM_DIR/$MOTHOS_SELECTED_OC"
  fi
fi
LOG_VFIO="$VM_DIR/logs/qemu_nullmoth_vfio.log"
WATCHDOG_SECS="${NULLMOTH_WATCHDOG_SECS:-600}"

if [ "$EUID" -ne 0 ]; then
  echo "[ERRO] Execute como root: sudo /root/iniciar-nullmoth-vfio.sh"
  exit 1
fi

on_error() {
  local lineno="$1"
  local rc="$2"
  trap - ERR
  set +e
  echo "[ERRO] Falha na linha $lineno (codigo $rc) ao iniciar NullMoth VFIO! Acionando reversao automatica..."
  /root/reverte-tudo.sh || true
  exit 1
}
trap 'on_error $LINENO $?' ERR

[ -x "$QEMU_BIN" ] || { echo "[ERRO] QEMU nao encontrado em $QEMU_BIN"; exit 1; }
[ -f "$OC_NM" ]    || { echo "[ERRO] $OC_NM nao encontrado"; exit 1; }

# Tuning de hardware e servidor HTTP de confirmacao (porta 8888)
[ -x /usr/local/bin/reims-hardware-tune.sh ] && /usr/local/bin/reims-hardware-tune.sh 2>/dev/null || true
if ! ss -tln | grep -q ":8888 "; then
  nohup python3 /root/nullmoth_setup/serve_http.py >/tmp/nullmoth_http.log 2>&1 </dev/null &
fi

echo "==> [1/5] Parando VM atual (reims-vgpu)..."
/root/bt-control.sh detach 2>/dev/null || true
/usr/local/bin/reims-ctl stop mac --timeout 25 2>/dev/null || true
sleep 2
QEMU_PIDS=$(pidof qemu-system-x86_64 2>/dev/null || true)
if [ -n "$QEMU_PIDS" ]; then
  kill -9 $QEMU_PIDS 2>/dev/null || true
  sleep 2
fi

echo "==> [2/5] Encerrando Xorg/getty e liberando RTX 3070 (07:00.0 / 07:00.1)..."
systemctl stop getty@tty1.service 2>/dev/null || true
pkill -TERM -x openbox 2>/dev/null || true
pkill -TERM -x Xorg 2>/dev/null || true
sleep 2
pkill -KILL -x openbox 2>/dev/null || true
pkill -KILL -x Xorg 2>/dev/null || true
systemctl stop nvidia-persistenced.service 2>/dev/null || true
sleep 1

for vt in /sys/class/vtconsole/vtcon*; do
  [ -e "$vt/bind" ] && echo 0 > "$vt/bind" 2>/dev/null || true
done
for fb in /sys/bus/platform/drivers/efi-framebuffer /sys/bus/platform/drivers/simple-framebuffer; do
  for dev in "$fb"/efi-framebuffer.* "$fb"/simple-framebuffer.*; do
    [ -e "$dev" ] && basename "$dev" > "$fb/unbind" 2>/dev/null || true
  done
done

NV_PIDS=$(ls -l /proc/[0-9]*/fd/* 2>/dev/null | awk -F' -> ' '/ -> \/dev\/(nvidia|dri\/(card|render))/{split($1,a,"/proc/"); split(a[2],b,"/"); if (b[1] ~ /^[0-9]+$/) print b[1]}' | sort -u | grep -vx "$$" | tr "\n" " " || true)
if [ -n "${NV_PIDS// /}" ]; then
  echo "    Encerrando processos residuais em /dev/nvidia*: $NV_PIDS"
  kill -TERM $NV_PIDS 2>/dev/null || true
  sleep 1
  kill -KILL $NV_PIDS 2>/dev/null || true
fi

echo "==> [2.5/5] Alocando HugePages de 2 MB (12288 MB = 6144 paginas)..."
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
echo 1 > /proc/sys/vm/compact_memory 2>/dev/null || true
echo 6144 > /proc/sys/vm/nr_hugepages 2>/dev/null || true
FREE_HP=$(awk '/HugePages_Free:/{print $2}' /proc/meminfo)
if [ "${FREE_HP:-0}" -ge 6144 ] && [ -d /dev/hugepages ]; then
  echo "    HugePages OK ($FREE_HP paginas livres em /dev/hugepages)."
  RAM_BACKEND="memory-backend-file,id=ram,size=12288M,mem-path=/dev/hugepages,share=on,prealloc=on,prealloc-threads=8"
else
  echo "    Aviso: HugePages insuficientes ($FREE_HP/6144); usando fallback memfd."
  echo 0 > /proc/sys/vm/nr_hugepages 2>/dev/null || true
  RAM_BACKEND="memory-backend-memfd,id=ram,size=12288M,share=on,prealloc=on,prealloc-threads=8"
fi

echo "==> [3/5] Vinculando RTX 3070, audio HDMI e USB 09:00.3 ao vfio-pci..."
modprobe vfio-pci

if [ -e /sys/bus/pci/drivers/nvidia/0000:07:00.0 ]; then
  echo "0000:07:00.0" > /sys/bus/pci/drivers/nvidia/unbind 2>/dev/null || true
fi
if [ -e /sys/bus/pci/drivers/snd_hda_intel/0000:07:00.1 ]; then
  echo "0000:07:00.1" > /sys/bus/pci/drivers/snd_hda_intel/unbind 2>/dev/null || true
fi

modprobe -r nvidia_drm nvidia_modeset nvidia_uvm nvidia 2>/dev/null || true

for dev in 0000:07:00.0 0000:07:00.1; do
  if [ ! -e "/sys/bus/pci/drivers/vfio-pci/$dev" ]; then
    CUR_DRV=$(readlink -f "/sys/bus/pci/devices/$dev/driver" 2>/dev/null || true)
    if [ -n "$CUR_DRV" ] && [ -e "$CUR_DRV/unbind" ]; then
      echo "$dev" > "$CUR_DRV/unbind" 2>/dev/null || true
    fi
    echo "vfio-pci" > "/sys/bus/pci/devices/$dev/driver_override"
    echo "$dev" > /sys/bus/pci/drivers/vfio-pci/bind
  fi
done

[ -e /sys/bus/pci/drivers/vfio-pci/0000:07:00.0 ] || { echo "[ERRO] 0000:07:00.0 nao vinculado ao vfio-pci"; exit 1; }
[ -e /sys/bus/pci/drivers/vfio-pci/0000:07:00.1 ] || { echo "[ERRO] 0000:07:00.1 nao vinculado ao vfio-pci"; exit 1; }

USB_VFIO_OK=0
if [ -e /sys/bus/pci/devices/0000:09:00.3 ]; then
  (
    set +e
    trap - ERR
    dev="0000:09:00.3"
    if [ ! -e "/sys/bus/pci/drivers/vfio-pci/$dev" ]; then
      CUR_DRV=$(readlink -f "/sys/bus/pci/devices/$dev/driver" 2>/dev/null || true)
      if [ -n "$CUR_DRV" ] && [ -e "$CUR_DRV/unbind" ]; then
        echo "$dev" > "$CUR_DRV/unbind" 2>/dev/null || true
      fi
      echo "vfio-pci" > "/sys/bus/pci/devices/$dev/driver_override" 2>/dev/null || true
      echo "$dev" > /sys/bus/pci/drivers/vfio-pci/bind 2>/dev/null || true
    fi
    if [ ! -e "/sys/bus/pci/drivers/vfio-pci/$dev" ]; then
      echo "" > "/sys/bus/pci/devices/$dev/driver_override" 2>/dev/null || true
      modprobe xhci_pci 2>/dev/null || true
      echo "$dev" > /sys/bus/pci/drivers_probe 2>/dev/null || true
      exit 1
    fi
    exit 0
  ) && USB_VFIO_OK=1 || USB_VFIO_OK=0
fi

if [ "$USB_VFIO_OK" -eq 1 ]; then
  echo "    Controlador USB 0000:09:00.3 em passthrough VFIO nativo!"
  USB_ARGS=(
    -device 'vfio-pci,host=09:00.3'
    -device 'usb-host,id=usb-compx-24g,bus=xhci.0,port=1,vendorid=0x25a7,productid=0xfa70'
  )
else
  echo "    Aviso: 0000:09:00.3 mantido no Linux; usando fallback usb-host em xhci.0."
  USB_ARGS=(
    -device 'usb-host,id=usb-kbd-0416,bus=xhci.0,port=1,vendorid=0x0416,productid=0x7372'
    -device 'usb-host,id=usb-darmoshark-rf,bus=xhci.0,port=2,vendorid=0x248a,productid=0xff30'
    -device 'usb-host,id=usb-darmoshark-m3,bus=xhci.0,port=4,vendorid=0x248a,productid=0xff12'
    -device 'usb-host,id=usb-compx-24g,bus=xhci.0,port=5,vendorid=0x25a7,productid=0xfa70'
  )
fi

BT_USB_ARGS=()
if [ ! -f /root/.nullmoth_disable_bt ]; then
  BT_SYSFS=""
  for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] && [ -f "$d/idProduct" ] || continue
    if [ "$(cat "$d/idVendor" 2>/dev/null || true)" = "8087" ] && [ "$(cat "$d/idProduct" 2>/dev/null || true)" = "0029" ]; then
      BT_SYSFS="$d"
      break
    fi
  done
  if [ -n "$BT_SYSFS" ] && [ "$(cat "$BT_SYSFS/authorized" 2>/dev/null || echo 0)" = "1" ]; then
    (
      set +e
      trap - ERR
      BT_DEV_NAME=$(basename "$BT_SYSFS")
      # Evita Kernel Oops (mgmt_pending_remove) impedindo que o udev suba bluetoothd durante o unbind do btusb
      systemctl mask --runtime bluetooth.service 2>/dev/null || true
      systemctl stop bluetooth.service 2>/dev/null || true
      if ! lsmod | grep -q "^btusb[[:space:]]"; then
        mark_ts=$(date '+%Y-%m-%d %H:%M:%S')
        echo "    Pre-carregando firmware Intel AX200 BT (ibt-20-1-3.sfi) no host..."
        modprobe btusb 2>/dev/null || true
        for _fw_try in 1 2 3 4 5; do
          sleep 1
          if journalctl -k --since "$mark_ts" 2>/dev/null | grep -qiE "Firmware revision|Found device firmware|ibt-20|Bootloader revision"; then
            break
          fi
        done
      fi
      sleep 0.5
      command -v hciconfig >/dev/null 2>&1 && timeout 5 hciconfig hci0 down 2>/dev/null || true
      for iface in "$BT_SYSFS"/"$BT_DEV_NAME":*; do
        if [ -L "$iface/driver" ] && [ "$(basename "$(readlink -f "$iface/driver")")" = "btusb" ]; then
          timeout 5 bash -c 'basename "$1" > "$1/driver/unbind"' _ "$iface" 2>/dev/null || true
        fi
      done
      timeout 5 modprobe -r btusb btintel bluetooth 2>/dev/null || timeout 5 modprobe -r btusb 2>/dev/null || true
    ) || true
    [ -w "$BT_SYSFS/avoid_reset_quirk" ] && echo 1 > "$BT_SYSFS/avoid_reset_quirk" 2>/dev/null || true
    [ -w "$BT_SYSFS/power/control" ] && echo on > "$BT_SYSFS/power/control" 2>/dev/null || true
    echo "    Bluetooth Intel 8087:0029 ($BT_SYSFS) preparado (firmware pre-carregado, avoid_reset_quirk=1, port=3, guest-reset=false)."
    BT_USB_ARGS=(
      -device 'usb-host,id=usb-8087-0029,bus=xhci.0,port=3,vendorid=0x8087,productid=0x0029,guest-reset=false,guest-resets-all=false'
    )
  else
    echo "    Aviso: Bluetooth 8087:0029 ausente ou nao autorizado no host; VM iniciara sem BT USB."
  fi
else
  echo "    Bluetooth 8087:0029 desabilitado via /root/.nullmoth_disable_bt."
fi
if [ "${#BT_USB_ARGS[@]}" -gt 0 ]; then
  USB_ARGS+=("${BT_USB_ARGS[@]}")
fi

echo "    Status PCI 07:00.0 / 07:00.1 / 09:00.3:"
lspci -nnk -s 07:00.0 -s 07:00.1 -s 09:00.3

echo "==> [4/5] Iniciando QEMU com RTX 3070 VFIO Passthrough + OpenCore ($OC_NM)..."
rm -f /tmp/nullmoth_confirm_ok /tmp/nullmoth_watchdog.pid
mkdir -p "$(dirname "$LOG_VFIO")"

export XDG_RUNTIME_DIR="/run/user/1000"
nohup "$QEMU_BIN" \
  -name mac \
  -machine 'q35,memory-backend=ram,dump-guest-core=off,max-ram-below-4g=1G' \
  -object "$RAM_BACKEND" \
  -accel kvm \
  -m 12288M \
  -cpu 'Skylake-Client-noTSX-IBRS,kvm=on,vendor=GenuineIntel,+invtsc,vmware-cpuid-freq=on,l3-cache=on,-pcid,+invpcid,+avx2,+fma,+bmi1,+bmi2,+f16c,+movbe,+ssse3,+sse4.2,+popcnt,+avx,+aes,+xsave,+xsaveopt,check' \
  -smp '8,sockets=1,cores=4,threads=2' \
  -global 'ICH9-LPC.acpi-pci-hotplug-with-bridge-support=off' \
  -global 'ICH9-LPC.disable_s3=1' \
  -fw_cfg 'name=opt/ovmf/X-PciMmio64Mb,string=32768' \
  -device 'pcie-root-port,id=pcie_gpu,bus=pcie.0,addr=0x1,slot=1,chassis=1,speed=16,width=16' \
  -device 'isa-applesmc,osk=ourhardworkbythesewordsguardedpleasedontsteal(c)AppleComputerInc' \
  -drive "if=pflash,format=raw,readonly=on,file=$VM_DIR/OVMF_CODE.fd" \
  -drive "if=pflash,format=raw,file=$VM_DIR/OVMF_VARS.fd" \
  -smbios 'type=2' \
  -device 'ich9-ahci,id=sata,addr=0x2' \
  -drive "id=opencore,if=none,format=qcow2,file=$OC_NM" \
  -device 'ide-hd,bus=sata.2,drive=opencore,bootindex=1' \
  -drive "id=disk,if=none,format=qcow2,file=$VM_DIR/disk.qcow2,cache=none,aio=threads,discard=unmap,detect-zeroes=unmap,l2-cache-size=16M,cache-clean-interval=300" \
  -device 'nvme,drive=disk,serial=reims-ctl,addr=0xa' \
  -netdev 'user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:2222-:22' \
  -device 'virtio-net-pci,netdev=net0,id=net0,mac=52:54:00:ce:12:6f,addr=0x3' \
  -vga none \
  -display none \
  -device 'vfio-pci,host=07:00.0,bus=pcie_gpu,addr=0x0.0,multifunction=on' \
  -device 'vfio-pci,host=07:00.1,bus=pcie_gpu,addr=0x0.1' \
  -device 'qemu-xhci,id=xhci,addr=0x5,conditional-intr-mapping=on,p2=7,p3=7' \
  "${USB_ARGS[@]}" \
  -audiodev 'pipewire,id=snd0' \
  -device 'virtio-sound-pci,id=audio,audiodev=snd0,addr=0x7,streams=1' \
  -device 'virtio-sound-pci,id=audioin,audiodev=snd0,addr=0x8,streams=1,input-streams=1' \
  -serial "file:$VM_DIR/logs/serial.log" \
  -msg 'timestamp=on' \
  -monitor none \
  -qmp "unix:$VM_DIR/qmp.sock,server=on,wait=off" \
  -pidfile "$VM_DIR/qemu.pid" \
  -device 'vfio-pci,host=05:00.0' \
  >"$LOG_VFIO" 2>&1 &

QEMU_PID=$!
sleep 3
if ! kill -0 "$QEMU_PID" 2>/dev/null; then
  echo "[ERRO] QEMU encerrou logo ao iniciar! Veja $LOG_VFIO:"
  tail -n 30 "$LOG_VFIO" || true
  trap - ERR
  /root/reverte-tudo.sh
  exit 1
fi

echo "    Aplicando CPU pinning 1:1 (vCPUs 0..7 -> CPUs 1,7,2,8,3,9,4,10; host/IRQs -> 0,5,6,11)..."
taskset -cp 0,5,6,11 "$QEMU_PID" >/dev/null 2>&1 || true
pin_qemu_threads() {
  local -a VCPU_MAP=(1 7 2 8 3 9 4 10)
  local t comm tid idx
  for t in /proc/"$QEMU_PID"/task/*; do
    [ -e "$t" ] || continue
    comm=$(cat "$t/comm" 2>/dev/null || true)
    tid=$(basename "$t")
    case "$comm" in
      CPU\ [0-7]/KVM)
        idx=${comm#CPU }
        idx=${idx%/KVM}
        taskset -cp "${VCPU_MAP[$idx]}" "$tid" >/dev/null 2>&1 || true
        ;;
      *)
        taskset -cp 0,5,6,11 "$tid" >/dev/null 2>&1 || true
        ;;
    esac
  done
}
pin_qemu_threads

pin_vfio_irqs() {
  pin_qemu_threads || true
  for irq in $(awk '/0000:(07:00\.[01]|05:00\.0|09:00\.3|06:00\.0)|enp6s0/{gsub(":","",$1); print $1}' /proc/interrupts 2>/dev/null || true); do
    [ -w "/proc/irq/$irq/smp_affinity_list" ] && echo "0,5,6,11" > "/proc/irq/$irq/smp_affinity_list" 2>/dev/null || true
  done
  setpci -s 07:00.0 CAP_EXP+0x08.w=5000:7000 2>/dev/null || true
}
pin_vfio_irqs || true
(set +e; trap - ERR; sleep 60 && pin_vfio_irqs) </dev/null >/dev/null 2>&1 &

if [ "${#BT_USB_ARGS[@]}" -gt 0 ]; then
  (
    set +e
    trap - ERR
    for _i in $(seq 1 36); do
      sleep 5
      kill -0 "$QEMU_PID" 2>/dev/null || exit 0
      ERR_CNT=$(grep -c "libusb_set_interface_alt_setting: -99" "$LOG_VFIO" 2>/dev/null || true)
      if [ "${ERR_CNT:-0}" -ge 3 ]; then
        echo "$(date): [BT-GUARD] Detectados $ERR_CNT erros -99 em $LOG_VFIO; desanexando usb-8087-0029 via QMP." >> /tmp/nullmoth_bt_guard.log
        /root/bt-control.sh detach >> /tmp/nullmoth_bt_guard.log 2>&1 || true
        exit 0
      fi
    done
  ) </dev/null >/dev/null 2>&1 &
fi

trap - ERR
if [ -f /root/.nullmoth_vfio_default ]; then
  echo "==> [5/5] Modo RTX 3070 VFIO ja confirmado como padrao permanente (/root/.nullmoth_vfio_default); watchdog desabilitado."
  exit 0
fi

echo "==> [5/5] Ativando Watchdog de seguranca (${WATCHDOG_SECS}s)..."
nohup bash -c "
  elapsed=0
  while [ \$elapsed -lt $WATCHDOG_SECS ]; do
    if [ -f /tmp/nullmoth_confirm_ok ]; then
      echo \"\$(date): Watchdog desarmado pelo usuario.\" >> /tmp/nullmoth_watchdog.log
      rm -f /tmp/nullmoth_watchdog.pid
      exit 0
    fi
    if ! kill -0 $QEMU_PID 2>/dev/null; then
      echo \"\$(date): QEMU VFIO ($QEMU_PID) caiu prematuramente; revertendo...\" >> /tmp/nullmoth_watchdog.log
      /root/reverte-tudo.sh >> /tmp/nullmoth_watchdog.log 2>&1
      exit 0
    fi
    sleep 5
    elapsed=\$((elapsed + 5))
  done
  if [ ! -f /tmp/nullmoth_confirm_ok ]; then
    echo \"\$(date): Timeout de ${WATCHDOG_SECS}s sem confirmacao; revertendo...\" >> /tmp/nullmoth_watchdog.log
    /root/reverte-tudo.sh >> /tmp/nullmoth_watchdog.log 2>&1
  fi
" >/dev/null 2>&1 &
echo $! > /tmp/nullmoth_watchdog.pid

echo ""
echo "========================================================================"
echo " VM iniciada com RTX 3070 VFIO (PID=$QEMU_PID)!"
echo " Watchdog ativo por ${WATCHDOG_SECS}s (PID=$(cat /tmp/nullmoth_watchdog.pid))."
echo " Se o video aparecer OK no monitor:"
echo "   curl -fsSL http://192.168.18.10:8888/ok"
echo " Para reverter manualmente a qualquer momento:"
echo "   sudo /root/reverte-tudo.sh  (ou: curl -fsSL http://192.168.18.10:8888/reverter)"
echo "========================================================================"
