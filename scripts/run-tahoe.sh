#!/usr/bin/env bash
# ==============================================================================
# REIMS - Launcher do macOS Tahoe
# TODAS as configurações vêm de reims.env — edite lá, não aqui.
# Calibrado para: AMD Ryzen 5 5600X | NVIDIA RTX 3070 | SSD NVMe
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
log "INFO" "Driver GPU   : $DRIVER_GPU"
log "INFO" "VRAM         : ${VRAM_MB}MB"
log "INFO" "Vulkan ICD   : $VK_ICD"
log "INFO" "RAM VM       : $RAM"
log "INFO" "Resolução    : $RESOLUCAO (fixa)"
log "INFO" "Display Mode : $DISPLAY_MODE"

# ── Variáveis de Aceleração Vulkan ───────────────────────────────────────────
export VK_ICD_FILENAMES="$VK_ICD"
export __GL_THREADED_OPTIMIZATIONS=1
export __GL_VRR_ALLOWED=1

# ── Verificar udmabuf ────────────────────────────────────────────────────────
if [ ! -e /dev/udmabuf ]; then
    log "AVISO" "udmabuf não detectado. Tentando carregar..."
    sudo modprobe udmabuf || log "ERRO" "Falha ao carregar udmabuf"
fi

# ── Gerenciamento de Discos (Camada Imutável) ─────────────────────────────────
if [ ! -f "$DISCO_BASE" ]; then
    log "INFO" "Imagem base não encontrada. Criando $DISCO_BASE ($DISCO_TAMANHO)..."
    mkdir -p vms
    qemu-img create -f qcow2 "$DISCO_BASE" "$DISCO_TAMANHO"
fi

if [ ! -f "$DISCO_LIVE" ]; then
    log "INFO" "Criando camada dinâmica sobre a base..."
    qemu-img create -f qcow2 -b "$DISCO_BASE" -F qcow2 "$DISCO_LIVE"
fi

# ── Configuração de Display ───────────────────────────────────────────────────
# Modo: Debian como backend invisível, macOS em tela cheia fixa
if [ "$DISPLAY_MODE" = "headless" ]; then
    DISPLAY_ARGS="-display none -vnc :0,password=off"
    log "INFO" "Modo headless ativo — acesso via VNC :5900 ou SSH"
elif [ "$FULLSCREEN" = "on" ]; then
    DISPLAY_ARGS="-display ${DISPLAY_MODE},gl=${GL_ACCEL},full-screen=on"
    log "INFO" "Tela cheia fixa ativada ($RESOLUCAO)"
else
    DISPLAY_ARGS="-display ${DISPLAY_MODE},gl=${GL_ACCEL}"
fi

# ── Configuração de Rede com forward SSH para o macOS ─────────────────────────
NET_ARGS="-device ${REDE_MODELO},netdev=net0 -netdev user,id=net0,hostfwd=tcp::${SSH_PORTA_HOST}-:22"

# ── Executar QEMU ─────────────────────────────────────────────────────────────
log "INFO" "Iniciando QEMU..."

qemu-system-x86_64 \
    -enable-kvm \
    -m "$RAM" \
    -smp "${CPU_THREADS},sockets=1,cores=${CPU_CORES},threads=2" \
    -cpu "${CPU_MODEL},vendor=${CPU_VENDOR},${CPU_FLAGS}" \
    -machine q35,accel=kvm,kernel_irqchip=on \
    -object memory-backend-memfd,id=mem0,size="${RAM}",share=on \
    -numa node,memdev=mem0 \
    -device virtio-balloon-pci \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_CODE}" \
    -drive if=pflash,format=raw,file="${OVMF_VARS}" \
    -drive id=OpenCore,if=none,format=raw,file="${OPENCORE_IMG}" \
    -device ide-hd,bus=ide.2,drive=OpenCore \
    -drive id=MacHDD,if=none,format=qcow2,file="${DISCO_LIVE}" \
    -device virtio-blk-pci,drive=MacHDD \
    -device "${DRIVER_GPU},vram_size_mb=${VRAM_MB}" \
    ${DISPLAY_ARGS} \
    ${NET_ARGS} \
    -device "${AUDIO_MODELO}" \
    -device hda-output \
    -usb \
    -device usb-xhci,id=xhci \
    -device usb-kbd \
    -device usb-tablet \
    -device virtio-serial \
    -chardev spicevmc,id=vdagent,debug=0,name=vdagent \
    -device virtserialport,chardev=vdagent,name=com.redhat.spice.0 \
    2>&1 | tee -a "$LOG_FILE"

EXIT_CODE="${PIPESTATUS[0]}"
if [ "$EXIT_CODE" -ne 0 ]; then
    log "ERRO" "QEMU encerrou com código $EXIT_CODE — veja: $LOG_FILE"
else
    log "INFO" "VM encerrada normalmente."
fi
