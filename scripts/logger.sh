#!/usr/bin/env bash
# ==============================================================================
# REIMS - Sistema de Logs Centralizado
# Toda execução, erro, alerta e evento do QEMU é gravado com timestamp.
# Consulte os logs com: ./reims logs
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOGS_DIR"

SESSION_ID="$(date +%Y%m%d_%H%M%S)"
LOG_SESSION="$LOGS_DIR/session_${SESSION_ID}.log"
LOG_LATEST="$LOGS_DIR/latest.log"
LOG_ERROS="$LOGS_DIR/erros.log"
MAX_LOGS=10

# Função pública: log com timestamp
reims_log() {
    local NIVEL="$1"
    local MSG="$2"
    local TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
    local LINHA="[$TIMESTAMP] [$NIVEL] $MSG"
    echo "$LINHA" >> "$LOG_SESSION"
    echo "$LINHA" >> "$LOG_LATEST"
    [ "$NIVEL" = "ERRO" ] && echo "$LINHA" >> "$LOG_ERROS"
}

# Iniciar sessão
reims_log "INFO" "==============================="
reims_log "INFO" "Nova sessão REIMS iniciada"
reims_log "INFO" "Hardware: AMD Ryzen 5 5600X | NVIDIA RTX 3070"
reims_log "INFO" "SO Host: $(uname -sr)"
reims_log "INFO" "==============================="

# Limpeza de logs antigos (mantém os últimos MAX_LOGS)
SESSION_COUNT=$(find "$LOGS_DIR" -name "session_*.log" | wc -l)
if [ "$SESSION_COUNT" -gt "$MAX_LOGS" ]; then
    EXCESSO=$((SESSION_COUNT - MAX_LOGS))
    find "$LOGS_DIR" -name "session_*.log" | sort | head -n "$EXCESSO" | xargs rm -f
fi

# Exportar para outros scripts usarem
export REIMS_LOG_SESSION="$LOG_SESSION"
export REIMS_LOG_DIR="$LOGS_DIR"
export SESSION_ID

echo "$LOG_SESSION"
