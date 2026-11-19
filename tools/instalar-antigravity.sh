#!/usr/bin/env bash
# ==============================================================================
# REIMS — Instalador do Antigravity CLI (agy) no Debian
# Permite continuar conversando com a IA diretamente no terminal do Linux.
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
RESET="\e[0m"

echo -e "${AZUL}==> Baixando e instalando o Antigravity CLI (agy)...${RESET}"

# 1. Executa o instalador oficial do Antigravity
curl -fsSL https://antigravity.google/cli/install.sh | bash

# 2. Garante o caminho no PATH do shell
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
fi

echo ""
echo -e "${VERDE}=========================================================="
echo " [✓] Antigravity CLI instalado com sucesso!"
echo "=========================================================="
echo ""
echo -e " Para conversar comigo e gerenciar o sistema no Debian, digite:${RESET}"
echo -e "   ${AZUL}agy${RESET}"
echo -e "${VERDE}==========================================================${RESET}"
