#!/usr/bin/env bash
# ==============================================================================
# REIMS - Gerenciador SSH
# Configura acesso remoto ao host Debian e cria túnel direto para o macOS.
# ==============================================================================

set -uo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/reims.env"

ACAO="${1:-status}"

# IP local do host Debian
IP_HOST=$(hostname -I | awk '{print $1}')

case "$ACAO" in
    setup)
        echo -e "${AZUL}==> Configurando acesso SSH ao host Debian...${RESET}"

        # Instala e habilita SSH no Debian
        sudo apt install -y openssh-server
        sudo systemctl enable --now ssh

        # Configura porta customizada se definida no reims.env
        if ! grep -q "Port $SSH_LISTEN_PORT" /etc/ssh/sshd_config 2>/dev/null; then
            echo "Port $SSH_LISTEN_PORT" | sudo tee -a /etc/ssh/sshd_config > /dev/null
            sudo systemctl restart ssh
        fi

        # Adiciona chave pública se definida
        if [ -n "$SSH_AUTHORIZED_KEYS" ]; then
            mkdir -p ~/.ssh && chmod 700 ~/.ssh
            echo "$SSH_AUTHORIZED_KEYS" >> ~/.ssh/authorized_keys
            chmod 600 ~/.ssh/authorized_keys
            echo -e "${VERDE}[✓] Chave pública adicionada — acesso sem senha configurado${RESET}"
        fi

        echo ""
        echo -e "${VERDE}======================================================"
        echo " SSH do host Debian configurado com sucesso!"
        echo "======================================================"
        echo ""
        echo -e " Para acessar de outro computador:${RESET}"
        echo -e "   ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST${RESET}"
        echo ""
        echo -e " Para gerenciar a VM remotamente:${RESET}"
        echo -e "   ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST './reims start'${RESET}"
        echo -e "   ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST './reims doctor'${RESET}"
        echo -e "   ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST './reims logs tail'${RESET}"
        echo ""
        echo -e " Para acessar o SSH do macOS (via túnel):${RESET}"
        echo -e "   ${AZUL}ssh -p $SSH_PORTA_HOST \$USER@$IP_HOST${RESET}"
        echo -e "${VERDE}======================================================${RESET}"
        ;;

    status)
        echo -e "${AZUL}=== Conexões SSH Disponíveis ===${RESET}"
        echo ""
        echo -e "  Host Debian  : ${VERDE}$IP_HOST${RESET}"
        echo -e "  Porta Host   : ${VERDE}$SSH_LISTEN_PORT${RESET}"
        echo -e "  Porta macOS  : ${VERDE}$SSH_PORTA_HOST${RESET} (túnel direto)"
        echo ""
        echo -e "  Acesso ao host:"
        echo -e "    ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST${RESET}"
        echo ""
        echo -e "  Acesso direto ao macOS Tahoe (VM rodando):"
        echo -e "    ${AZUL}ssh -p $SSH_PORTA_HOST \$USER@$IP_HOST${RESET}"
        echo ""
        echo -e "  Gerenciamento remoto completo:"
        echo -e "    ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST './reims start'${RESET}"
        echo -e "    ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST './reims backup'${RESET}"
        echo -e "    ${AZUL}ssh -p $SSH_LISTEN_PORT \$USER@$IP_HOST 'cat logs/latest.log'${RESET}"

        # Verifica se SSH está rodando
        if systemctl is-active --quiet ssh 2>/dev/null; then
            echo ""
            echo -e "  Status SSH: ${VERDE}[✓] Serviço ativo${RESET}"
        else
            echo ""
            echo -e "  Status SSH: ${AMARELO}[!] Serviço inativo — execute: ./reims ssh setup${RESET}"
        fi
        ;;

    mac)
        # Túnel direto para o SSH do macOS dentro da VM
        echo -e "${AZUL}==> Conectando ao SSH do macOS Tahoe via túnel...${RESET}"
        echo -e "    (Certifique-se de que a VM está rodando e SSH está ativo no macOS)"
        ssh -p "$SSH_PORTA_HOST" "$USER@localhost" "${@:2}"
        ;;

    headless)
        # Coloca a VM em modo headless (sem tela, só SSH)
        echo -e "${AZUL}==> Alternando para modo headless (backend puro)...${RESET}"
        sed -i 's/^DISPLAY_MODE=.*/DISPLAY_MODE="headless"/' "$SCRIPT_DIR/reims.env"
        echo -e "${VERDE}[✓] DISPLAY_MODE=headless salvo em reims.env${RESET}"
        echo -e "    Acesse a VM via: ssh -p $SSH_PORTA_HOST \$USER@$IP_HOST"
        ;;

    janela)
        # Volta para modo janela normal com tela cheia
        sed -i 's/^DISPLAY_MODE=.*/DISPLAY_MODE="sdl"/' "$SCRIPT_DIR/reims.env"
        echo -e "${VERDE}[✓] DISPLAY_MODE=sdl restaurado em reims.env${RESET}"
        ;;
esac
