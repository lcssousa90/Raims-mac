#!/usr/bin/env bash
# ==============================================================================
# REIMS - Monitor em Tempo Real (RTX 3070 + VM)
# Exibe temperatura, VRAM, uso de GPU e CPU enquanto o macOS Tahoe está rodando.
# Alerta automaticamente se qualquer métrica ultrapassar os limites seguros.
# ==============================================================================

set -uo pipefail

# ── Limites de Segurança ─────────────────────────────────────────────────────
TEMP_WARN=75     # °C — Aviso amarelo
TEMP_CRIT=85     # °C — Alerta vermelho + notificação
VRAM_WARN=6144   # MB — Aviso (6 GB de 8 GB)
VRAM_CRIT=7500   # MB — Alerta crítico (7.5 GB de 8 GB)
GPU_WARN=90      # % — Uso alto de GPU
INTERVALO=2      # segundos entre atualizações

# ── Cores ────────────────────────────────────────────────────────────────────
VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
CIANO="\e[1;36m"
BRANCO="\e[1;37m"
DIM="\e[2m"
RESET="\e[0m"
CLEAR_LINE="\r\e[K"

# Verificar dependências
for dep in nvidia-smi; do
    if ! command -v "$dep" &>/dev/null; then
        echo -e "${VERMELHO}[ERRO]${RESET} Dependência ausente: $dep"
        [ "$dep" = "nvidia-smi" ] && echo "       Instale o driver NVIDIA: sudo apt install -y nvidia-driver"
        [ "$dep" = "bc" ] && echo "       sudo apt install -y bc"
        exit 1
    fi
done

# Função: barra de progresso colorida
barra() {
    local VALOR="$1"
    local MAX="$2"
    local LARGURA=30
    local PREENCHIDO=$(( VALOR * LARGURA / MAX ))
    local VAZIO=$(( LARGURA - PREENCHIDO ))
    local COR="$VERDE"
    local PCT=$(( VALOR * 100 / MAX ))
    [ "$PCT" -ge 60 ] && COR="$AMARELO"
    [ "$PCT" -ge 85 ] && COR="$VERMELHO"
    printf "%s" "${COR}["
    printf '%0.s█' $(seq 1 "$PREENCHIDO" 2>/dev/null) 2>/dev/null || true
    printf '%0.s░' $(seq 1 "$VAZIO" 2>/dev/null) 2>/dev/null || true
    printf "%s" "]${RESET}"
    printf " %s%3d%%%s" "$COR" "$PCT" "$RESET"
}

# Função: cor baseada em temperatura
cor_temp() {
    local T="$1"
    if [ "$T" -ge "$TEMP_CRIT" ]; then echo -n "$VERMELHO"
    elif [ "$T" -ge "$TEMP_WARN" ]; then echo -n "$AMARELO"
    else echo -n "$VERDE"
    fi
}

# Função: notificação de sistema (se disponível)
notificar() {
    local MSG="$1"
    if command -v notify-send &>/dev/null; then
        notify-send -u critical -i dialog-warning "REIMS Monitor" "$MSG" 2>/dev/null || true
    fi
}

# Capturar CTRL+C para sair limpo
RODANDO=true
trap 'RODANDO=false; echo -e "\n${AZUL}==> Monitor encerrado.${RESET}"; exit 0' INT TERM

# Limpar tela
clear

# Loop principal de monitoramento
ALERTA_TEMP_ENVIADO=false
ALERTA_VRAM_ENVIADO=false

while $RODANDO; do
    # Coletar dados da GPU via nvidia-smi
    DADOS=$(nvidia-smi \
        --query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu,utilization.memory,power.draw,clocks.current.graphics,fan.speed \
        --format=csv,noheader,nounits 2>/dev/null || echo "0,0,8192,0,0,0,0,0")

    TEMP=$(echo "$DADOS" | awk -F', ' '{print $1}' | tr -d ' ')
    VRAM_USADO=$(echo "$DADOS" | awk -F', ' '{print $2}' | tr -d ' ')
    VRAM_TOTAL=$(echo "$DADOS" | awk -F', ' '{print $3}' | tr -d ' ')
    GPU_USO=$(echo "$DADOS" | awk -F', ' '{print $4}' | tr -d ' ')
    MEM_USO=$(echo "$DADOS" | awk -F', ' '{print $5}' | tr -d ' ')
    POTENCIA=$(echo "$DADOS" | awk -F', ' '{print $6}' | tr -d ' ')
    CLOCK=$(echo "$DADOS" | awk -F', ' '{print $7}' | tr -d ' ')
    FAN=$(echo "$DADOS" | awk -F', ' '{print $8}' | tr -d ' ')

    # Coletar uso de CPU e RAM do host
    CPU_USO=$(LC_ALL=C top -bn1 | grep "Cpu(s)" | awk '{print $2}' | sed 's/%us,//' | tr -d ' ' | cut -d'.' -f1 2>/dev/null || echo "0")
    RAM_INFO=$(LC_ALL=C free -m | awk '/^Mem:/{printf "%d %d", $3, $2}')
    RAM_USADO=$(echo "$RAM_INFO" | awk '{print $1}')
    RAM_TOTAL=$(echo "$RAM_INFO" | awk '{print $2}')

    # Alertas automáticos
    if [ "${TEMP:-0}" -ge "$TEMP_CRIT" ] && [ "$ALERTA_TEMP_ENVIADO" = false ]; then
        notificar "🔥 RTX 3070 em temperatura crítica: ${TEMP}°C! Reduza a carga da VM."
        ALERTA_TEMP_ENVIADO=true
    elif [ "${TEMP:-0}" -lt "$TEMP_WARN" ]; then
        ALERTA_TEMP_ENVIADO=false
    fi

    if [ "${VRAM_USADO:-0}" -ge "$VRAM_CRIT" ] && [ "$ALERTA_VRAM_ENVIADO" = false ]; then
        notificar "⚠️ VRAM da RTX 3070 quase esgotada: ${VRAM_USADO}MB/${VRAM_TOTAL}MB"
        ALERTA_VRAM_ENVIADO=true
    elif [ "${VRAM_USADO:-0}" -lt "$VRAM_WARN" ]; then
        ALERTA_VRAM_ENVIADO=false
    fi

    # Renderizar o painel
    tput cup 0 0
    echo -e "${CIANO}╔══════════════════════════════════════════════════════╗${RESET}"
    echo -e "${CIANO}║${RESET}     ${BRANCO}REIMS MONITOR — macOS Tahoe em Execução${RESET}      ${CIANO}║${RESET}"
    echo -e "${CIANO}║${RESET}  ${DIM}Ryzen 5 5600X + RTX 3070 | Atualiza a cada ${INTERVALO}s${RESET}    ${CIANO}║${RESET}"
    echo -e "${CIANO}╠══════════════════════════════════════════════════════╣${RESET}"
    echo ""

    # GPU
    echo -e "  ${BRANCO}GPU — NVIDIA GeForce RTX 3070${RESET}"
    COR_T=$(cor_temp "${TEMP:-0}")
    echo -e "  Temperatura  : ${COR_T}${TEMP}°C${RESET}"
    echo -ne "  Uso GPU      : "; barra "${GPU_USO:-0}" 100; echo ""
    echo -ne "  VRAM         : "; barra "${VRAM_USADO:-0}" "${VRAM_TOTAL:-8192}"; echo " (${VRAM_USADO}/${VRAM_TOTAL} MB)"
    echo -ne "  Mem. Banda   : "; barra "${MEM_USO:-0}" 100; echo ""
    echo -e "  Clock GPU    : ${VERDE}${CLOCK} MHz${RESET}   Fan: ${VERDE}${FAN}%${RESET}   TDP: ${VERDE}${POTENCIA}W${RESET}"
    echo ""

    # Host
    echo -e "  ${BRANCO}Host Linux (Ryzen 5 5600X)${RESET}"
    echo -ne "  CPU Total    : "; barra "${CPU_USO:-0}" 100; echo ""
    echo -ne "  RAM Host     : "; barra "${RAM_USADO:-0}" "${RAM_TOTAL:-16384}"; echo " (${RAM_USADO}/${RAM_TOTAL} MB)"
    echo ""

    # Status de saúde
    echo -e "${CIANO}╠══════════════════════════════════════════════════════╣${RESET}"
    SAUDE="${VERDE}✓ Sistema operando normalmente${RESET}"
    [ "${TEMP:-0}" -ge "$TEMP_WARN" ] && SAUDE="${AMARELO}! Temperatura elevada — verifique a ventilação${RESET}"
    [ "${TEMP:-0}" -ge "$TEMP_CRIT" ] && SAUDE="${VERMELHO}✗ TEMPERATURA CRÍTICA — reduza a carga!${RESET}"
    [ "${VRAM_USADO:-0}" -ge "$VRAM_WARN" ] && SAUDE="${AMARELO}! VRAM quase esgotada (${VRAM_USADO}MB/${VRAM_TOTAL}MB)${RESET}"
    [ "${VRAM_USADO:-0}" -ge "$VRAM_CRIT" ] && SAUDE="${VERMELHO}✗ VRAM CRÍTICA — feche apps no macOS!${RESET}"
    echo -e "  Status: $SAUDE"
    echo -e "${CIANO}╚══════════════════════════════════════════════════════╝${RESET}"
    echo -e "  ${DIM}Pressione Ctrl+C para sair${RESET}"

    sleep "$INTERVALO"
done
