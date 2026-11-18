#!/usr/bin/env bash
# ==============================================================================
# REIMS — Instalador Ultraleve via GitHub (Para colocar no Pen Drive)
# Basta rodar este arquivo único no Debian: ele baixa tudo e instala sozinho!
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
RESET="\e[0m"

echo -e "${AZUL}=========================================================="
echo "   REIMS — Instalador Automático via GitHub"
echo -e "==========================================================${RESET}"
echo ""

# 1. Garante que o Git e curl estão instalados no Debian
if ! command -v git &>/dev/null; then
    echo -e "${AZUL}==> Instalando Git no sistema...${RESET}"
    sudo apt update
    sudo apt install -y git curl
fi

# 2. Pergunta o link do repositório (ou usa o padrão configurado)
REPO_PADRAO="https://github.com/lcssousa90/Raims-mac.git"
echo -e "${AMARELO}Digite a URL do seu repositório GitHub:${RESET}"
echo -e "Pressione [Enter] para usar: ${AZUL}${REPO_PADRAO}${RESET}"
read -rp "URL: " REPO_URL
REPO_URL="${REPO_URL:-$REPO_PADRAO}"

DESTINO="$HOME/reims-mac"

# 3. Clona ou atualiza o projeto
if [ -d "$DESTINO/.git" ]; then
    echo -e "${AZUL}==> Projeto já existe. Atualizando com git pull...${RESET}"
    cd "$DESTINO"
    git pull
else
    echo -e "${AZUL}==> Clonando repositório para $DESTINO...${RESET}"
    git clone "$REPO_URL" "$DESTINO"
    cd "$DESTINO"
fi

# 4. Concede permissão de execução
chmod +x reims scripts/*.sh tools/*.sh

echo ""
echo -e "${VERDE}[✓] Repositório baixado com sucesso!${RESET}"
echo -e "${AZUL}==> Iniciando o assistente de instalação do REIMS...${RESET}"
echo ""

# 5. Roda o setup automaticamente
./reims
