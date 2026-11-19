#!/usr/bin/env bash
# ==============================================================================
# REIMS - Script de Pré-Voo (Pre-Flight Check)
# Valida todos os requisitos de hardware, udmabuf (teste real ioctl),
# Vulkan, PipeWire, QEMU e firmware ANTES de iniciar a VM.
# ==============================================================================

set -uo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/reims.env" ] && source "$SCRIPT_DIR/reims.env"

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

if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    ok "Permissão de leitura/escrita em /dev/kvm correta"
else
    fail "Sem permissão completa em /dev/kvm"
    info "Correção: sudo usermod -aG kvm \$USER && newgrp kvm"
fi

echo ""

# ── 2. MEMÓRIA COMPARTILHADA (vGPU / udmabuf) ─────────────────────────────────
echo -e "${AZUL}[ vGPU & udmabuf (Zero-Copy DMA) ]${RESET}"

if [ -e /dev/udmabuf ]; then
    ok "/dev/udmabuf carregado"
else
    fail "/dev/udmabuf não encontrado — a paravirtualização gráfica vai falhar"
    info "Correção: sudo modprobe udmabuf"
fi

if [ -r /dev/udmabuf ] && [ -w /dev/udmabuf ]; then
    ok "Permissão de acesso ao /dev/udmabuf correta"
else
    fail "Sem permissão de leitura/escrita em /dev/udmabuf"
    info "Correção: sudo tee /etc/udev/rules.d/99-udmabuf.rules <<< 'KERNEL==\"udmabuf\", SUBSYSTEM==\"misc\", MODE=\"0666\"'"
fi

if [ -f /sys/module/udmabuf/parameters/size_limit_mb ]; then
    SIZE_LIM=$(cat /sys/module/udmabuf/parameters/size_limit_mb 2>/dev/null || echo "0")
    LIST_LIM=$(cat /sys/module/udmabuf/parameters/list_limit 2>/dev/null || echo "0")
    if [ "$SIZE_LIM" -ge 2048 ]; then
        fail "udmabuf size_limit_mb=${SIZE_LIM} (>= 2048 causa overflow de 32-bit no kernel -> EINVAL!)"
        info "Correção: echo 1024 | sudo tee /sys/module/udmabuf/parameters/size_limit_mb"
    elif [ "$SIZE_LIM" -le 0 ]; then
        fail "udmabuf size_limit_mb=${SIZE_LIM} inválido"
    else
        ok "Parâmetros udmabuf seguros: size_limit_mb=${SIZE_LIM}, list_limit=${LIST_LIM}"
    fi
fi

if [ -r /dev/udmabuf ] && [ -w /dev/udmabuf ] && command -v python3 >/dev/null 2>&1; then
    IOCTL_OUT=$(python3 - <<'PY' 2>&1
import os, fcntl, ctypes, ctypes.util

F_ADD_SEALS = 1033
F_SEAL_SHRINK = 0x0002
UDMABUF_CREATE = 0x40187542

class UdmabufCreate(ctypes.Structure):
    _fields_ = [
        ("memfd", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("offset", ctypes.c_uint64),
        ("size", ctypes.c_uint64),
    ]

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
memfd = os.memfd_create("reims_preflight", 2)
os.ftruncate(memfd, 4096)
fcntl.fcntl(memfd, F_ADD_SEALS, F_SEAL_SHRINK)
ufd = os.open("/dev/udmabuf", os.O_RDWR)
req = UdmabufCreate(memfd=memfd, flags=0, offset=0, size=4096)
dmabuf = libc.ioctl(ufd, ctypes.c_ulong(UDMABUF_CREATE), ctypes.byref(req))
if dmabuf < 0:
    err = ctypes.get_errno()
    os.close(ufd)
    os.close(memfd)
    raise OSError(err, os.strerror(err))
os.close(dmabuf)
os.close(ufd)
os.close(memfd)
print("OK")
PY
    )
    if [ "$IOCTL_OUT" = "OK" ]; then
        ok "Teste real ioctl(UDMABUF_CREATE) passou — Zero-Copy DMA funcional"
    else
        fail "Teste real ioctl(UDMABUF_CREATE) falhou: $IOCTL_OUT"
        info "Verifique /sys/module/udmabuf/parameters/size_limit_mb (use 1024)"
    fi
fi

MAX_MAP_NOW=$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo "0")
if [ "$MAX_MAP_NOW" -ge 2097152 ]; then
    ok "vm.max_map_count adequado ($MAX_MAP_NOW)"
else
    warn "vm.max_map_count baixo ($MAX_MAP_NOW; recomendado >= 4194304)"
    info "Correção: sudo sysctl -w vm.max_map_count=4194304"
fi

echo ""

# ── 3. DRIVER NVIDIA E VULKAN ────────────────────────────────────────────────
echo -e "${AZUL}[ GPU & Driver Vulkan ]${RESET}"

if command -v vulkaninfo &>/dev/null; then
    ok "vulkan-tools instalado"
    if vulkaninfo --summary 2>/dev/null | grep -q "NVIDIA"; then
        GPU_NAME=$(vulkaninfo --summary 2>/dev/null | grep "deviceName" | head -1 | awk -F'= ' '{print $2}')
        ok "GPU respondendo ao Vulkan: $GPU_NAME"
    else
        warn "Driver Vulkan instalado, mas GPU NVIDIA não listada"
        info "Correção: sudo apt install -y nvidia-driver libvulkan1 && reboot"
    fi
else
    fail "vulkaninfo não encontrado — bibliotecas Vulkan ausentes"
    info "Correção: sudo apt install -y vulkan-tools libvulkan1 mesa-vulkan-drivers"
fi

NVIDIA_ICD="${VK_ICD:-/usr/share/vulkan/icd.d/nvidia_icd.json}"
if [ -f "$NVIDIA_ICD" ]; then
    ok "ICD Vulkan encontrado em $NVIDIA_ICD"
else
    fail "Arquivo ICD da NVIDIA não encontrado em $NVIDIA_ICD"
    info "Correção: sudo apt install -y libvulkan-dev nvidia-driver"
fi

echo ""

# ── 4. ÁUDIO PIPEWIRE ────────────────────────────────────────────────────────
echo -e "${AZUL}[ Áudio PipeWire ]${RESET}"

PW_SOCK="${PIPEWIRE_RUNTIME_DIR:-/run/user/1000}/pipewire-0"
if [ -S "$PW_SOCK" ]; then
    ok "Socket PipeWire ativo em $PW_SOCK"
else
    warn "Socket PipeWire não encontrado em $PW_SOCK — áudio da VM pode não funcionar"
    info "Correção: sudo loginctl enable-linger mac && systemctl --user -M mac@ start pipewire wireplumber"
fi

echo ""

# ── 5. QEMU, OVMF E DISCOS ───────────────────────────────────────────────────
echo -e "${AZUL}[ QEMU, Firmware UEFI & Discos ]${RESET}"

QEMU_REIMS="/root/.local/share/reims-ctl/qemu/current/bin/qemu-system-x86_64"
if [ "${USE_REIMS_CTL:-true}" = "true" ] && [ -x "$QEMU_REIMS" ]; then
    QEMU_VER=$("$QEMU_REIMS" --version | head -1)
    ok "QEMU Reims-vGPU ativo: $QEMU_VER"
elif command -v qemu-system-x86_64 &>/dev/null; then
    QEMU_VER=$(qemu-system-x86_64 --version | head -1)
    ok "QEMU instalado: $QEMU_VER"
else
    fail "qemu-system-x86_64 não encontrado"
    info "Correção: sudo apt install -y qemu-system-x86"
fi

CTL_DIR="${REIMS_CTL_VM_DIR:-/root/.local/share/reims-ctl/vms/mac}"
if [ "${USE_REIMS_CTL:-true}" = "true" ] && [ -d "$CTL_DIR" ]; then
    info "Modo reims-ctl detectado ($CTL_DIR)"
    [ -f "$CTL_DIR/OVMF_CODE.fd" ]  && ok "OVMF_CODE.fd presente em $CTL_DIR" || fail "OVMF_CODE.fd ausente em $CTL_DIR"
    [ -f "$CTL_DIR/OVMF_VARS.fd" ]  && ok "OVMF_VARS.fd presente em $CTL_DIR" || fail "OVMF_VARS.fd ausente em $CTL_DIR"
    [ -f "$CTL_DIR/opencore.qcow2" ] && ok "opencore.qcow2 presente em $CTL_DIR" || fail "opencore.qcow2 ausente em $CTL_DIR"
    if [ -f "$CTL_DIR/disk.qcow2" ]; then
        SIZE=$(qemu-img info "$CTL_DIR/disk.qcow2" 2>/dev/null | grep "virtual size" | awk '{print $3, $4}')
        ok "disk.qcow2 encontrado ($SIZE)"
    else
        fail "disk.qcow2 ausente em $CTL_DIR"
    fi
else
    if [ "${USE_REIMS_CTL:-true}" = "true" ] && [ "$EUID" -ne 0 ]; then
        warn "Execute com sudo para inspecionar $CTL_DIR (reims-ctl)"
    fi
    [ -f "$SCRIPT_DIR/${OVMF_CODE:-efi/OVMF_CODE.fd}" ] && ok "OVMF_CODE.fd encontrado" || fail "efi/OVMF_CODE.fd não encontrado"
    [ -f "$SCRIPT_DIR/${OVMF_VARS:-efi/OVMF_VARS.fd}" ] && ok "OVMF_VARS.fd encontrado" || fail "efi/OVMF_VARS.fd não encontrado"
    [ -f "$SCRIPT_DIR/${OPENCORE_IMG:-efi/OpenCore_Tahoe.img}" ] && ok "OpenCore encontrado" || warn "${OPENCORE_IMG:-efi/OpenCore_Tahoe.img} não encontrado"
    if [ -f "$SCRIPT_DIR/${DISCO_BASE:-vms/tahoe_base.qcow2}" ]; then
        SIZE=$(qemu-img info "$SCRIPT_DIR/${DISCO_BASE:-vms/tahoe_base.qcow2}" 2>/dev/null | grep "virtual size" | awk '{print $3, $4}')
        ok "Disco base encontrado ($SIZE)"
    else
        warn "Disco base não encontrado — execute './reims create' ou configure USE_REIMS_CTL=true"
    fi
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
