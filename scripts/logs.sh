#!/usr/bin/env bash
# ==============================================================================
# REIMS - Visualizador de Logs
# Consulta interativa de sessões, erros e eventos em tempo real.
# ==============================================================================

set -uo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
DIM="\e[2m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"

if [ ! -d "$LOGS_DIR" ] || [ -z "$(ls -A "$LOGS_DIR" 2>/dev/null)" ]; then
    echo -e "${AMARELO}Nenhum log encontrado ainda. Execute a VM pelo menos uma vez.${RESET}"
    exit 0
fi

MODO="${1:-menu}"

case "$MODO" in
    tail|live)
        # Monitoramento ao vivo do log da sessão mais recente
        LATEST="$LOGS_DIR/latest.log"
        if [ -f "$LATEST" ]; then
            echo -e "${AZUL}==> Monitorando log em tempo real (Ctrl+C para sair):${RESET}"
            tail -f "$LATEST" | while read -r LINHA; do
                if echo "$LINHA" | grep -q "\[ERRO\]"; then
                    echo -e "${VERMELHO}$LINHA${RESET}"
                elif echo "$LINHA" | grep -q "\[AVISO\]"; then
                    echo -e "${AMARELO}$LINHA${RESET}"
                elif echo "$LINHA" | grep -q "\[OK\]"; then
                    echo -e "${VERDE}$LINHA${RESET}"
                else
                    echo -e "${DIM}$LINHA${RESET}"
                fi
            done
        fi
        ;;
    erros)
        # Apenas erros
        ERROS_LOG="$LOGS_DIR/erros.log"
        if [ -f "$ERROS_LOG" ] && [ -s "$ERROS_LOG" ]; then
            echo -e "${VERMELHO}=== Histórico de Erros ===${RESET}"
            cat "$ERROS_LOG"
        else
            echo -e "${VERDE}Nenhum erro registrado!${RESET}"
        fi
        ;;
    lista)
        # Lista todas as sessões disponíveis
        echo -e "${AZUL}=== Sessões de Log Disponíveis ===${RESET}"
        find "$LOGS_DIR" -name "session_*.log" | sort -r | while read -r f; do
            SIZE=$(du -sh "$f" | awk '{print $1}')
            DATE=$(basename "$f" | grep -oP '\d{8}_\d{6}' | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)_\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3 \4:\5:\6/')
            ERROS_COUNT=$(grep -c "\[ERRO\]" "$f" 2>/dev/null || echo 0)
            echo -e "  ${DIM}$(basename "$f")${RESET} — ${DATE} (${SIZE}) ${ERROS_COUNT} erro(s)"
        done
        ;;
    limpar)
        read -rp "Remover todos os logs? (s/N): " CONF
        [[ "$CONF" =~ ^[sS]$ ]] && rm -rf "$LOGS_DIR"/*.log && echo -e "${VERDE}Logs removidos.${RESET}" || echo "Cancelado."
        ;;
    *)
        echo -e "${AZUL}=== REIMS Logs ===${RESET}"
        echo ""
        echo "  Uso: ./reims logs <opção>"
        echo ""
        echo "  tail    — Monitoramento ao vivo (sessão atual)"
        echo "  erros   — Ver apenas erros registrados"
        echo "  lista   — Listar todas as sessões"
        echo "  limpar  — Remover todos os logs"
        echo ""
        echo -e "  Log mais recente: ${DIM}$LOGS_DIR/latest.log${RESET}"
        echo ""
        # Resumo rápido
        TOTAL_SESSOES=$(find "$LOGS_DIR" -name "session_*.log" 2>/dev/null | wc -l)
        TOTAL_ERROS=$(cat "$LOGS_DIR/erros.log" 2>/dev/null | wc -l || echo 0)
        echo -e "  Total de sessões: ${VERDE}$TOTAL_SESSOES${RESET}   Erros registrados: $([ "$TOTAL_ERROS" -gt 0 ] && echo -e "${VERMELHO}$TOTAL_ERROS${RESET}" || echo -e "${VERDE}0${RESET}")"
        ;;
esac
