#!/usr/bin/env bash
# ==============================================================================
# REIMS — Instalador do Plugin Cockpit Web UI
# Instala o Cockpit no Debian e ativa o painel web nativo do REIMS na porta 9090.
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$SCRIPT_DIR/cockpit-plugin"
COCKPIT_DEST="/usr/share/cockpit/reims"

echo -e "${AZUL}==> Instalando e configurando Cockpit Web UI para o REIMS...${RESET}"

# 1. Instalar o Cockpit se necessário
if ! command -v cockpit-bridge &>/dev/null; then
    echo -e "${AZUL}==> Instalando pacote Cockpit via APT...${RESET}"
    sudo apt update
    sudo apt install -y cockpit
fi

# 2. Registrar o plugin do REIMS no sistema
echo -e "${AZUL}==> Vinculando plugin REIMS ao Cockpit...${RESET}"
sudo mkdir -p "$COCKPIT_DEST"
sudo cp -r "$PLUGIN_SRC"/* "$COCKPIT_DEST/"
sudo chmod -R 755 "$COCKPIT_DEST"

# 3. Habilitar e iniciar o serviço do Cockpit
echo -e "${AZUL}==> Ativando serviço do Cockpit...${RESET}"
sudo systemctl enable --now cockpit.socket

IP_LOCAL=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${VERDE}=========================================================="
echo " [✓] Painel Web do REIMS instalado com sucesso no Cockpit!"
echo "=========================================================="
echo ""
echo -e " Acesse pelo navegador de qualquer dispositivo na sua rede:${RESET}"
echo -e "   ${AZUL}https://${IP_LOCAL}:9090${RESET}"
echo -e "   ${DIM}(Ou localmente: https://localhost:9090)${RESET}"
echo ""
echo -e " Login: Use seu usuário e senha do Debian."
echo -e " O menu lateral exibirá a ferramenta: ${VERDE}macOS Tahoe (REIMS)${RESET}."
echo -e "${VERDE}==========================================================${RESET}"
