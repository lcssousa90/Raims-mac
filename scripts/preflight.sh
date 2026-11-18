#!/usr/bin/env bash
# ==============================================================================
# REIMS - Script de Pré-Voo (Pre-Flight Check)
# Valida todos os requisitos de hardware e kernel ANTES de tentar iniciar a VM.
# Se algo estiver errado, indica o comando exato de correção.
# ==============================================================================

set -uo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

ERROS=0
AVISOS=0

ok()    { echo -e "  ${VERDE}[✓]${RESET} $1"; }
fail()  { echo -e "  ${VERMELHO}[✗]${RESET} $1"; ERROS=$((ERROS+1)); }
warn()  { echo -e "  ${AMARELO}[!]${RESET} $1"; AVISOS=$((AVISOS+1)); }
info()  { echo -e "  ${AZUL}[→]${RESET} $1"; }

echo ""
echo -e "${AZUL}=========================================================="
echo "   REIMS PRE-FLIGHT CHECK - macOS Tahoe"
echo -e "==========================================================${RESET}"
echo ""

# ── 1. VIRTUALIZAÇÃO E KVM ───────────────────────────────────────────────────
echo -e "${AZUL}[ CPU & Virtualização ]${RESET}"

if grep -qE '(vmx|svm)' /proc/cpuinfo; then
    ok "Instruções de virtualização AMD-V / Intel VT-x ativas no processador"
else
    fail "Virtualização de CPU não detectada"
    info "Correção: Habilite AMD-V ou Intel VT-x na BIOS/UEFI"
fi

if [ -e /dev/kvm ]; then
    ok "/dev/kvm detectado — Aceleração KVM disponível"
else
    fail "/dev/kvm não encontrado"
    info "Correção: sudo modprobe kvm && sudo modprobe kvm_amd"
fi

if [ -r /dev/kvm ]; then
    ok "Permissão de leitura em /dev/kvm correta"
else
    fail "Sem permissão de leitura em /dev/kvm"
    info "Correção: sudo usermod -aG kvm \$USER && newgrp kvm"
fi

echo ""

# ── 2. MEMÓRIA COMPARTILHADA (vGPU) ─────────────────────────────────────────
echo -e "${AZUL}[ vGPU & udmabuf ]${RESET}"

if [ -e /dev/udmabuf ]; then
    ok "/dev/udmabuf carregado — Memória Zero-Copy pronta para o Reims"
else
    fail "/dev/udmabuf não encontrado — a paravirtualização gráfica vai falhar"
    info "Correção: sudo modprobe udmabuf"
    info "Persistência: echo 'udmabuf' | sudo tee -a /etc/modules"
fi

if [ -r /dev/udmabuf ]; then
    ok "Permissão de acesso ao udmabuf correta"
else
    fail "Sem permissão de leitura em /dev/udmabuf"
    info "Correção: sudo tee /etc/udev/rules.d/99-udmabuf.rules <<< 'KERNEL==\"udmabuf\", SUBSYSTEM==\"misc\", MODE=\"0666\"'"
fi

echo ""

# ── 3. DRIVER NVIDIA E VULKAN ────────────────────────────────────────────────
echo -e "${AZUL}[ GPU & Driver Vulkan ]${RESET}"

if command -v vulkaninfo &>/dev/null; then
    ok "vulkan-tools instalado"
    if vulkaninfo --summary 2>/dev/null | grep -q "NVIDIA"; then
        GPU_NAME=$(vulkaninfo --summary 2>/dev/null | grep "GPU" | head -1 | sed 's/.*GPU[0-9]*: //')
        ok "RTX 3070 respondendo ao Vulkan: $GPU_NAME"
    else
        warn "Driver Vulkan instalado, mas GPU NVIDIA não listada"
        info "Correção: sudo apt install -y nvidia-driver libvulkan1 && reboot"
    fi
else
    fail "vulkaninfo não encontrado — bibliotecas Vulkan ausentes"
    info "Correção: sudo apt install -y vulkan-tools libvulkan1 mesa-vulkan-drivers"
fi

NVIDIA_ICD="/usr/share/vulkan/icd.d/nvidia_icd.json"
if [ -f "$NVIDIA_ICD" ]; then
    ok "ICD NVIDIA encontrado em $NVIDIA_ICD"
else
    fail "Arquivo ICD da NVIDIA não encontrado — Vulkan vai usar fallback lento (Mesa)"
    info "Correção: sudo apt install -y libvulkan-dev nvidia-driver"
fi

echo ""

# ── 4. QEMU E OVMF ──────────────────────────────────────────────────────────
echo -e "${AZUL}[ QEMU & Firmware UEFI ]${RESET}"

if command -v qemu-system-x86_64 &>/dev/null; then
    QEMU_VER=$(qemu-system-x86_64 --version | head -1)
    ok "QEMU instalado: $QEMU_VER"
else
    fail "qemu-system-x86_64 não encontrado"
    info "Correção: sudo apt install -y qemu-system-x86"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$SCRIPT_DIR/efi/OVMF_CODE.fd" ]; then
    ok "OVMF_CODE.fd encontrado em efi/"
else
    fail "efi/OVMF_CODE.fd não encontrado — VM não vai bootar"
    info "Correção: Execute ./reims setup para copiar automaticamente"
fi

if [ -f "$SCRIPT_DIR/efi/OVMF_VARS.fd" ]; then
    ok "OVMF_VARS.fd encontrado em efi/"
else
    fail "efi/OVMF_VARS.fd não encontrado"
    info "Correção: Execute ./reims setup"
fi

if [ -f "$SCRIPT_DIR/efi/OpenCore_Tahoe.img" ]; then
    ok "OpenCore_Tahoe.img encontrado em efi/"
else
    warn "efi/OpenCore_Tahoe.img não encontrado — necessário antes de iniciar"
    info "Adicione a imagem EFI do OpenCore configurada para o Tahoe"
fi

echo ""

# ── 5. IMAGENS DE DISCO ──────────────────────────────────────────────────────
echo -e "${AZUL}[ Discos da VM ]${RESET}"

if [ -f "$SCRIPT_DIR/vms/tahoe_base.qcow2" ]; then
    SIZE=$(qemu-img info "$SCRIPT_DIR/vms/tahoe_base.qcow2" 2>/dev/null | grep "virtual size" | awk '{print $3, $4}')
    ok "tahoe_base.qcow2 encontrado ($SIZE)"
else
    warn "tahoe_base.qcow2 não encontrado — execute './reims create' para criar"
fi

if [ -f "$SCRIPT_DIR/vms/tahoe_live.qcow2" ]; then
    ok "tahoe_live.qcow2 (camada ativa) encontrado"
else
    warn "tahoe_live.qcow2 não encontrado — será criado automaticamente no primeiro start"
fi

echo ""

# ── RESULTADO FINAL ──────────────────────────────────────────────────────────
echo -e "${AZUL}==========================================================${RESET}"
if [ "$ERROS" -eq 0 ] && [ "$AVISOS" -eq 0 ]; then
    echo -e "  ${VERDE}Sistema 100% pronto. Execute: ./reims start${RESET}"
elif [ "$ERROS" -eq 0 ]; then
    echo -e "  ${AMARELO}Sistema com $AVISOS aviso(s) — verifique os itens acima antes de continuar.${RESET}"
else
    echo -e "  ${VERMELHO}$ERROS erro(s) crítico(s) encontrado(s) — corrija antes de iniciar a VM.${RESET}"
fi
echo -e "${AZUL}==========================================================${RESET}"
echo ""
exit "$ERROS"
