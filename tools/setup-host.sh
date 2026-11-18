#!/usr/bin/env bash
# ==============================================================================
# REIMS - Script de Preparação do Host (Debian/Linux)
# Configura KVM, udmabuf e dependências da RTX 3070 de forma segura e não destrutiva.
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

echo -e "${AZUL}==> Iniciando preparação do host para macOS Tahoe + Reims vGPU...${RESET}"

# 1. Privilégios de Administrador
# BUG CORRIGIDO: set -euo pipefail + sudo -v não funciona bem em conjunto.
# A verificação de EUID deve ser feita sem -e ativo para sudo -v.
if [ "$EUID" -ne 0 ]; then
    echo -e "${AZUL}==> Verificando acesso sudo...${RESET}"
    sudo true || { echo -e "${VERMELHO}[ERRO] Privilégios de sudo necessários.${RESET}"; exit 1; }
fi

# 2. Configurar repositórios sem sobrescrever sources.list
CODENAME=$(lsb_release -cs 2>/dev/null || echo "trixie")
echo -e "${AZUL}==> Configurando repositórios oficiais com non-free-firmware (${CODENAME})...${RESET}"

sudo tee /etc/apt/sources.list.d/reims-firmware.list > /dev/null << EOF
deb http://deb.debian.org/debian ${CODENAME} main contrib non-free non-free-firmware
deb http://deb.debian.org/debian-security ${CODENAME}-security main contrib non-free non-free-firmware
deb http://deb.debian.org/debian ${CODENAME}-updates main contrib non-free non-free-firmware
EOF

sudo apt update --allow-releaseinfo-change -y || sudo apt update --fix-missing -y

# 3. Instalar pacotes essenciais
echo -e "${AZUL}==> Instalando drivers, QEMU, Vulkan e DKMS...${RESET}"
sudo apt install -y \
    firmware-misc-non-free \
    build-essential \
    dkms \
    linux-headers-"$(uname -r)" \
    qemu-system-x86 \
    ovmf \
    libvulkan1 \
    mesa-vulkan-drivers \
    vulkan-tools \
    python3 \
    python3-requests \
    curl \
    whiptail \
    libglib2.0-0 \
    libpixman-1-0 \
    libsdl2-2.0-0

# 4. Ativar KVM e udmabuf
echo -e "${AZUL}==> Ativando módulos KVM e udmabuf...${RESET}"
sudo modprobe kvm || true
sudo modprobe kvm_amd || true
sudo modprobe udmabuf || true

# Garantir persistência dos módulos no boot
for mod in kvm kvm_amd udmabuf; do
    if ! grep -q "^$mod" /etc/modules 2>/dev/null; then
        echo "$mod" | sudo tee -a /etc/modules > /dev/null
    fi
done

# Regra udev para permissão do udmabuf sem root
sudo tee /etc/udev/rules.d/99-udmabuf.rules > /dev/null << 'EOF'
KERNEL=="udmabuf", SUBSYSTEM=="misc", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger

# Adicionar usuário aos grupos corretos
USUARIO_ATUAL="${SUDO_USER:-$USER}"
sudo usermod -aG kvm,render,input "$USUARIO_ATUAL" || true

# 5. Copiar firmware OVMF para a pasta efi/ do projeto
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$SCRIPT_DIR/efi"

OVMF_CODE=""
OVMF_VARS=""

# Localizar o firmware OVMF instalado no Debian
for f in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/qemu/OVMF.fd; do
    [ -f "$f" ] && { OVMF_CODE="$f"; break; }
done
for f in /usr/share/OVMF/OVMF_VARS_4M.fd /usr/share/OVMF/OVMF_VARS.fd; do
    [ -f "$f" ] && { OVMF_VARS="$f"; break; }
done

if [ -n "$OVMF_CODE" ]; then
    cp "$OVMF_CODE" "$SCRIPT_DIR/efi/OVMF_CODE.fd"
    echo -e "${VERDE}[OK] OVMF_CODE.fd copiado para efi/${RESET}"
else
    echo -e "${AMARELO}[AVISO] OVMF_CODE não encontrado. Instale o pacote 'ovmf' manualmente.${RESET}"
fi

if [ -n "$OVMF_VARS" ]; then
    cp "$OVMF_VARS" "$SCRIPT_DIR/efi/OVMF_VARS.fd"
    echo -e "${VERDE}[OK] OVMF_VARS.fd copiado para efi/${RESET}"
fi

echo -e "${VERDE}[OK] Host preparado com sucesso para rodar o macOS Tahoe!${RESET}"
echo ""
echo -e "${AZUL}Próximos passos:${RESET}"
echo "  1. Adicione o OpenCore_Tahoe.img na pasta efi/"
echo "  2. Execute: ./reims create  (baixa o macOS Tahoe)"
echo "  3. Execute: ./reims start   (inicia a VM)"
