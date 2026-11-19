#!/usr/bin/env bash
# ==============================================================================
# REIMS - Script de Preparação do Host (Debian/Linux)
# Configura KVM, udmabuf (zero-copy sem overflow), sysctl, PipeWire linger,
# isolamento Intel AX200 (VFIO + blacklist Bluetooth) e dependências da RTX 3070.
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/reims.env" ] && source "$SCRIPT_DIR/reims.env"

echo -e "${AZUL}==> Iniciando preparação do host para macOS Tahoe + Reims vGPU...${RESET}"

# 1. Privilégios de Administrador
if [ "$EUID" -ne 0 ]; then
    echo -e "${AZUL}==> Verificando acesso sudo...${RESET}"
    sudo true || { echo -e "${VERMELHO}[ERRO] Privilégios de sudo necessários.${RESET}"; exit 1; }
fi

# 2. Configurar repositórios sem sobrescrever sources.list
CODENAME=$(lsb_release -cs 2>/dev/null || echo "trixie")
echo -e "${AZUL}==> Configurando repositórios oficiais com non-free-firmware (${CODENAME})...${RESET}"

sudo tee /etc/apt/sources.list.d/reims-firmware.list > /dev/null << EOF_REPO
deb http://deb.debian.org/debian ${CODENAME} main contrib non-free non-free-firmware
deb http://deb.debian.org/debian-security ${CODENAME}-security main contrib non-free non-free-firmware
deb http://deb.debian.org/debian ${CODENAME}-updates main contrib non-free non-free-firmware
EOF_REPO

sudo apt update --allow-releaseinfo-change -y || sudo apt update --fix-missing -y

# 3. Instalar pacotes essenciais
echo -e "${AZUL}==> Instalando drivers, QEMU, Vulkan, utilitários e DKMS...${RESET}"
sudo apt install -y \
    firmware-misc-non-free \
    build-essential \
    dkms \
    linux-headers-"$(uname -r)" \
    qemu-system-x86 \
    qemu-utils \
    ovmf \
    libvulkan1 \
    mesa-vulkan-drivers \
    vulkan-tools \
    python3 \
    python3-requests \
    curl \
    bc \
    whiptail \
    libglib2.0-0 \
    libpixman-1-0 \
    libsdl2-2.0-0

# 4. Ativar KVM, udmabuf e VFIO
echo -e "${AZUL}==> Ativando módulos KVM, udmabuf e vfio-pci...${RESET}"
sudo modprobe kvm || true
sudo modprobe kvm_amd || sudo modprobe kvm_intel || true
sudo modprobe udmabuf || true
sudo modprobe vfio-pci || true
sudo modprobe nbd max_part=8 || true

for mod in kvm kvm_amd udmabuf vfio-pci; do
    if ! grep -q "^${mod}$" /etc/modules 2>/dev/null; then
        echo "$mod" | sudo tee -a /etc/modules > /dev/null
    fi
done

# Regra udev para permissão do udmabuf sem root
sudo tee /etc/udev/rules.d/99-udmabuf.rules > /dev/null << 'EOF_UDEV'
KERNEL=="udmabuf", SUBSYSTEM=="misc", MODE="0666"
EOF_UDEV
sudo udevadm control --reload-rules && sudo udevadm trigger

# 5. Configurar sysctl (vm.max_map_count + sched_autogroup)
MAX_MAP="${VM_MAX_MAP_COUNT:-4194304}"
echo -e "${AZUL}==> Configurando /etc/sysctl.d/99-reims-vgpu.conf (vm.max_map_count=${MAX_MAP})...${RESET}"
sudo tee /etc/sysctl.d/99-reims-vgpu.conf > /dev/null << EOF_SYSCTL
vm.max_map_count = ${MAX_MAP}
kernel.sched_autogroup_enabled = 0
EOF_SYSCTL
sudo sysctl --system >/dev/null || sudo sysctl -p /etc/sysctl.d/99-reims-vgpu.conf >/dev/null

# 6. Configurar udmabuf seguro (evita overflow de 32 bits se size_limit_mb >= 2048)
UDMA_MB="${UDMABUF_SIZE_LIMIT_MB:-1024}"
UDMA_LIST="${UDMABUF_LIST_LIMIT:-32768}"
if [ "$UDMA_MB" -ge 2048 ]; then
    echo -e "${AMARELO}[AVISO] UDMABUF_SIZE_LIMIT_MB=$UDMA_MB >= 2048 causa overflow no kernel; ajustando para 1024.${RESET}"
    UDMA_MB=1024
fi

if [ -d /sys/module/udmabuf/parameters ]; then
    echo "$UDMA_MB"   | sudo tee /sys/module/udmabuf/parameters/size_limit_mb > /dev/null
    echo "$UDMA_LIST" | sudo tee /sys/module/udmabuf/parameters/list_limit > /dev/null
    echo -e "${VERDE}[OK] udmabuf ajustado: size_limit_mb=${UDMA_MB}, list_limit=${UDMA_LIST}${RESET}"
fi

echo -e "${AZUL}==> Persistindo tuning de hardware em /usr/local/bin/reims-hardware-tune.sh...${RESET}"
sudo tee /usr/local/bin/reims-hardware-tune.sh > /dev/null << EOF_TUNE
#!/bin/bash
# 1. Expand udmabuf for zero-copy Metal-to-Vulkan DMA (<= 1024MB evita overflow 32-bit no kernel)
if [ -d /sys/module/udmabuf/parameters ]; then
    echo ${UDMA_MB} > /sys/module/udmabuf/parameters/size_limit_mb
    echo ${UDMA_LIST} > /sys/module/udmabuf/parameters/list_limit
fi

# 2. Lock RTX 3070 clocks to peak performance range (se nvidia-smi disponivel)
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi -pm 1 >/dev/null 2>&1 || true
    nvidia-smi -lgc 1800,2100 >/dev/null 2>&1 || true
    nvidia-smi -lmc 7001,7001 >/dev/null 2>&1 || true
fi

# 3. Disable CPU autogroup throttling
sysctl -w kernel.sched_autogroup_enabled=0 >/dev/null 2>&1 || true

exit 0
EOF_TUNE
sudo chmod +x /usr/local/bin/reims-hardware-tune.sh

sudo tee /etc/systemd/system/reims-hardware-tune.service > /dev/null << 'EOF_SVC'
[Unit]
Description=Reims vGPU Hardware & GPU Performance Tuning
After=multi-user.target nvidia-persistenced.service
Before=display-manager.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/reims-hardware-tune.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF_SVC
sudo systemctl daemon-reload
sudo systemctl enable reims-hardware-tune.service >/dev/null 2>&1 || true

# 7. Isolamento Intel AX200 (Wi-Fi via VFIO + Blacklist Bluetooth no host)
WIFI_ID="${WIFI_PCI_ID:-8086:2723}"
if lspci -n -d "$WIFI_ID" 2>/dev/null | grep -q .; then
    echo -e "${AZUL}==> Placa Intel AX200 ($WIFI_ID) detectada: configurando VFIO e liberando Bluetooth...${RESET}"
    sudo tee /etc/modprobe.d/vfio.conf > /dev/null << EOF_VFIO
options vfio-pci ids=${WIFI_ID}
softdep iwlwifi pre: vfio-pci
EOF_VFIO
    sudo tee /etc/modprobe.d/blacklist-bluetooth.conf > /dev/null << 'EOF_BT'
blacklist btusb
blacklist btintel
blacklist bluetooth
EOF_BT
    echo -e "${VERDE}[OK] Configurados /etc/modprobe.d/vfio.conf e blacklist-bluetooth.conf${RESET}"
else
    echo -e "${AMARELO}[INFO] Placa Intel AX200 ($WIFI_ID) não detectada neste host; mantendo modprobe inalterado.${RESET}"
fi

# 8. Permissões de grupo e Linger para PipeWire persistente
USUARIO_ATUAL="${SUDO_USER:-$USER}"
if [ "$USUARIO_ATUAL" = "root" ] && id "mac" >/dev/null 2>&1; then
    USUARIO_ATUAL="mac"
fi
sudo usermod -aG kvm,render,input "$USUARIO_ATUAL" || true
echo -e "${AZUL}==> Habilitando loginctl linger para usuário '$USUARIO_ATUAL' (PipeWire)...${RESET}"
sudo loginctl enable-linger "$USUARIO_ATUAL" 2>/dev/null || true

# 9. Copiar firmware OVMF para a pasta efi/ do projeto
mkdir -p "$SCRIPT_DIR/efi"

OVMF_CODE_SRC=""
OVMF_VARS_SRC=""

for f in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/qemu/OVMF.fd; do
    [ -f "$f" ] && { OVMF_CODE_SRC="$f"; break; }
done
for f in /usr/share/OVMF/OVMF_VARS_4M.fd /usr/share/OVMF/OVMF_VARS.fd; do
    [ -f "$f" ] && { OVMF_VARS_SRC="$f"; break; }
done

if [ -n "$OVMF_CODE_SRC" ]; then
    cp "$OVMF_CODE_SRC" "$SCRIPT_DIR/efi/OVMF_CODE.fd"
    echo -e "${VERDE}[OK] OVMF_CODE.fd copiado para efi/${RESET}"
else
    echo -e "${AMARELO}[AVISO] OVMF_CODE não encontrado. Instale o pacote 'ovmf' manualmente.${RESET}"
fi

if [ -n "$OVMF_VARS_SRC" ]; then
    cp "$OVMF_VARS_SRC" "$SCRIPT_DIR/efi/OVMF_VARS.fd"
    echo -e "${VERDE}[OK] OVMF_VARS.fd copiado para efi/${RESET}"
fi

echo -e "${VERDE}[OK] Host preparado com sucesso para rodar o macOS Tahoe!${RESET}"
echo ""
echo -e "${AZUL}Próximos passos:${RESET}"
echo "  1. Verifique tudo com: ./reims preflight"
echo "  2. Inicie a VM com:    ./reims start"
