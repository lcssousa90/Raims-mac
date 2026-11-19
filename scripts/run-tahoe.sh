#!/usr/bin/env bash
# ==============================================================================
# REIMS - Launcher do macOS Tahoe
# TODAS as configurações vêm de reims.env — edite lá, não aqui.
# Orquestra via reims-ctl (padrão) ou executa QEMU standalone corrigido.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Carregar configurações centrais ─────────────────────────────────────────
if [ ! -f "reims.env" ]; then
    echo "[ERRO] Arquivo reims.env não encontrado. O projeto pode estar incompleto."
    exit 1
fi
source reims.env

# ── Sistema de Logs ─────────────────────────────────────────────────────────
mkdir -p logs
SESSION_ID="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="logs/session_${SESSION_ID}.log"
ln -sf "session_${SESSION_ID}.log" logs/latest.log

log() {
    local NIVEL="$1"; local MSG="$2"
    local TS="$(date '+%Y-%m-%d %H:%M:%S')"
    local LINHA="[$TS] [$NIVEL] $MSG"
    echo "$LINHA" | tee -a "$LOG_FILE"
    [ "$NIVEL" = "ERRO" ] && echo "$LINHA" >> logs/erros.log
}

log "INFO" "======== Nova sessão REIMS ========"
log "INFO" "Modo         : ${GPU_MODE:-reims-vgpu} (USE_REIMS_CTL=${USE_REIMS_CTL:-true})"
log "INFO" "Driver GPU   : $DRIVER_GPU"
log "INFO" "Vulkan ICD   : $VK_ICD"
log "INFO" "RAM VM       : $RAM"

# ── Variáveis de Aceleração Vulkan & Áudio PipeWire ──────────────────────────
export VK_DRIVER_FILES="$VK_ICD"
export VK_ICD_FILENAMES="$VK_ICD"
export __GL_THREADED_OPTIMIZATIONS=1
export __GL_VRR_ALLOWED=1

PW_DIR="${PIPEWIRE_RUNTIME_DIR:-/run/user/1000}"
if [ -S "${PW_DIR}/pipewire-0" ]; then
    export XDG_RUNTIME_DIR="$PW_DIR"
    log "INFO" "PipeWire     : XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
else
    log "AVISO" "Socket PipeWire não encontrado em ${PW_DIR}/pipewire-0"
fi

# ── Verificar udmabuf e proteção contra overflow ─────────────────────────────
if [ ! -e /dev/udmabuf ]; then
    log "AVISO" "udmabuf não detectado. Tentando carregar..."
    sudo modprobe udmabuf || log "ERRO" "Falha ao carregar udmabuf"
fi

if [ -f /sys/module/udmabuf/parameters/size_limit_mb ]; then
    CUR_LIMIT=$(cat /sys/module/udmabuf/parameters/size_limit_mb 2>/dev/null || echo "0")
    if [ "$CUR_LIMIT" -ge 2048 ]; then
        log "AVISO" "udmabuf size_limit_mb=$CUR_LIMIT >= 2048 (risco de EINVAL); corrigindo para ${UDMABUF_SIZE_LIMIT_MB:-1024}..."
        echo "${UDMABUF_SIZE_LIMIT_MB:-1024}" | sudo tee /sys/module/udmabuf/parameters/size_limit_mb >/dev/null || true
    fi
fi

# ── Modo 1: Orquestração via reims-ctl (Recomendado) ─────────────────────────
if [ "${USE_REIMS_CTL:-true}" = "true" ] && [ -x "/usr/local/bin/reims-ctl" ]; then
    TARGET_VM="${VM_NAME:-mac}"
    log "INFO" "Delegando inicialização da VM '$TARGET_VM' para /usr/local/bin/reims-ctl..."
    /usr/local/bin/reims-ctl start "$TARGET_VM" 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE="${PIPESTATUS[0]}"
    if [ "$EXIT_CODE" -ne 0 ]; then
        log "ERRO" "reims-ctl encerrou com código $EXIT_CODE — veja: $LOG_FILE"
    else
        log "INFO" "VM '$TARGET_VM' iniciada via reims-ctl."
    fi
    exit "$EXIT_CODE"
fi

# ── Modo 2: QEMU Standalone (Fallback completo) ──────────────────────────────
BASE_ABS="$SCRIPT_DIR/$DISCO_BASE"
LIVE_ABS="$SCRIPT_DIR/$DISCO_LIVE"

if [ ! -f "$BASE_ABS" ]; then
    log "INFO" "Imagem base não encontrada. Criando $BASE_ABS ($DISCO_TAMANHO)..."
    mkdir -p "$(dirname "$BASE_ABS")"
    qemu-img create -f qcow2 "$BASE_ABS" "$DISCO_TAMANHO"
fi

if [ ! -f "$LIVE_ABS" ]; then
    log "INFO" "Criando camada dinâmica sobre a base ($BASE_ABS)..."
    mkdir -p "$(dirname "$LIVE_ABS")"
    qemu-img create -f qcow2 -b "$BASE_ABS" -F qcow2 "$LIVE_ABS"
fi

QEMU_BIN="qemu-system-x86_64"
if [ -x "/root/.local/share/reims-ctl/qemu/current/bin/qemu-system-x86_64" ]; then
    QEMU_BIN="/root/.local/share/reims-ctl/qemu/current/bin/qemu-system-x86_64"
fi

GPU_ARGS=()
if [ "$DRIVER_GPU" = "reims-graphics-pci" ]; then
    ROM_PATH=$(ls /root/.local/share/reims-ctl/prebuilt/ReimsGraphics-*.rom 2>/dev/null | head -n1 || true)
    if [ -n "$ROM_PATH" ]; then
        GPU_ARGS+=(-vga none -device "reims-graphics-pci,id=gfx,bus=pcie.0,addr=0x4,romfile=${ROM_PATH}" -display none)
    else
        GPU_ARGS+=(-vga none -device "reims-graphics-pci,id=gfx,bus=pcie.0,addr=0x4" -display none)
    fi
else
    if [ "$DISPLAY_MODE" = "headless" ]; then
        GPU_ARGS+=(-device "${DRIVER_GPU},vram_size_mb=${VRAM_MB}" -display none -vnc :0,password=off)
    elif [ "$FULLSCREEN" = "on" ]; then
        GPU_ARGS+=(-device "${DRIVER_GPU},vram_size_mb=${VRAM_MB}" -display "${DISPLAY_MODE},gl=${GL_ACCEL},full-screen=on")
    else
        GPU_ARGS+=(-device "${DRIVER_GPU},vram_size_mb=${VRAM_MB}" -display "${DISPLAY_MODE},gl=${GL_ACCEL}")
    fi
fi

EXTRA_PASSTHROUGH=()
if [ -n "${WIFI_VFIO_PCI:-}" ] && [ -e "/sys/bus/pci/drivers/vfio-pci/0000:${WIFI_VFIO_PCI}" ]; then
    EXTRA_PASSTHROUGH+=(-device "vfio-pci,host=${WIFI_VFIO_PCI}")
fi
if [ -n "${BT_USB_VENDOR:-}" ] && [ -n "${BT_USB_PRODUCT:-}" ]; then
    EXTRA_PASSTHROUGH+=(-device "usb-host,id=usb-bt,bus=xhci.0,vendorid=${BT_USB_VENDOR},productid=${BT_USB_PRODUCT},guest-reset=true,guest-resets-all=true")
fi

log "INFO" "Iniciando QEMU standalone ($QEMU_BIN)..."

"$QEMU_BIN" \
    -name "${VM_NAME:-mac}" \
    -machine "q35,memory-backend=mem0,dump-guest-core=off,max-ram-below-4g=1G" \
    -object "memory-backend-memfd,id=mem0,size=${RAM},share=on,prealloc=on,prealloc-threads=${CPU_CORES}" \
    -accel kvm \
    -m "$RAM" \
    -smp "${CPU_THREADS},sockets=1,cores=${CPU_CORES},threads=1" \
    -cpu "${CPU_MODEL},vendor=${CPU_VENDOR},${CPU_FLAGS}" \
    -global ICH9-LPC.acpi-pci-hotplug-with-bridge-support=off \
    -global ICH9-LPC.disable_s3=1 \
    -device pcie-root-port,bus=pcie.0,addr=0x1,slot=1,speed=16,width=32 \
    -device "isa-applesmc,osk=ourhardworkbythesewordsguardedpleasedontsteal(c)AppleComputerInc" \
    -drive "if=pflash,format=raw,readonly=on,file=${SCRIPT_DIR}/${OVMF_CODE}" \
    -drive "if=pflash,format=raw,file=${SCRIPT_DIR}/${OVMF_VARS}" \
    -smbios type=2 \
    -device ich9-ahci,id=sata,addr=0x2 \
    -drive "id=OpenCore,if=none,format=qcow2,file=${SCRIPT_DIR}/${OPENCORE_IMG}" \
    -device ide-hd,bus=sata.2,drive=OpenCore,bootindex=1 \
    -drive "id=MacHDD,if=none,format=qcow2,file=${LIVE_ABS},discard=unmap" \
    -device nvme,drive=MacHDD,serial=reims-ctl,addr=0xa \
    -netdev "user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:${SSH_PORTA_HOST}-:22" \
    -device "${REDE_MODELO},netdev=net0,id=net0,addr=0x3" \
    "${GPU_ARGS[@]}" \
    -device "qemu-xhci,id=xhci,addr=0x5,conditional-intr-mapping=on,p2=${USB_P2_PORTS:-7},p3=${USB_P3_PORTS:-7}" \
    -device usb-kbd,id=kbd,bus=xhci.0 \
    -device usb-tablet,id=tablet,bus=xhci.0 \
    -audiodev pipewire,id=snd0 \
    -device virtio-sound-pci,id=audio,audiodev=snd0,addr=0x7,streams=1 \
    -device virtio-sound-pci,id=audioin,audiodev=snd0,addr=0x8,streams=1,input-streams=1 \
    -device "${AUDIO_MODELO},id=hda,addr=0x1b" \
    -device hda-output,bus=hda.0,audiodev=snd0 \
    "${EXTRA_PASSTHROUGH[@]}" \
    2>&1 | tee -a "$LOG_FILE"

EXIT_CODE="${PIPESTATUS[0]}"
if [ "$EXIT_CODE" -ne 0 ]; then
    log "ERRO" "QEMU encerrou com código $EXIT_CODE — veja: $LOG_FILE"
else
    log "INFO" "VM encerrada normalmente."
fi
