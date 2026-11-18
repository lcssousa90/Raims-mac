#!/usr/bin/env bash
# ==============================================================================
# REIMS - Backup Automático da Imagem Base
# Cria um snapshot com data/hora da imagem base antes de qualquer operação crítica.
# Mantém os últimos 3 backups e remove os mais antigos automaticamente.
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VMS_DIR="$SCRIPT_DIR/vms"
BACKUPS_DIR="$SCRIPT_DIR/backups"
BASE_DISK="$VMS_DIR/tahoe_base.qcow2"
MAX_BACKUPS=3

mkdir -p "$BACKUPS_DIR"

echo -e "${AZUL}==> REIMS Backup — Proteção da Imagem Base${RESET}"

# Verifica se a imagem base existe
if [ ! -f "$BASE_DISK" ]; then
    echo -e "${VERMELHO}[ERRO] Imagem base não encontrada em: $BASE_DISK${RESET}"
    exit 1
fi

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
MOTIVO="${1:-manual}"
BACKUP_FILE="$BACKUPS_DIR/tahoe_base__${TIMESTAMP}__${MOTIVO}.qcow2"

echo -e "${AZUL}==> Criando backup: $(basename "$BACKUP_FILE")${RESET}"
echo -e "    Origem:  $BASE_DISK"
echo -e "    Destino: $BACKUP_FILE"
echo ""

# Verifica espaço em disco disponível (mínimo 20 GB)
BASE_SIZE_BYTES=$(du -sb "$BASE_DISK" | awk '{print $1}')
AVAILABLE_BYTES=$(df --output=avail -B1 "$BACKUPS_DIR" | tail -1)
REQUIRED_BYTES=$((BASE_SIZE_BYTES + 1073741824)) # +1 GB de margem

if [ "$AVAILABLE_BYTES" -lt "$REQUIRED_BYTES" ]; then
    BASE_SIZE_GB=$(echo "scale=1; $BASE_SIZE_BYTES/1073741824" | bc)
    AVAIL_GB=$(echo "scale=1; $AVAILABLE_BYTES/1073741824" | bc)
    echo -e "${VERMELHO}[ERRO] Espaço insuficiente: necessário ~${BASE_SIZE_GB}GB, disponível ${AVAIL_GB}GB${RESET}"
    exit 1
fi

# Cria backup comprimido com snapshot interno do QCOW2 (muito mais rápido que cp)
echo -e "==> Comprimindo e copiando (isso pode levar alguns minutos)..."
qemu-img convert -f qcow2 -O qcow2 -c "$BASE_DISK" "$BACKUP_FILE"

# Verifica integridade do backup criado
if qemu-img check "$BACKUP_FILE" &>/dev/null; then
    BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | awk '{print $1}')
    echo -e "${VERDE}[✓] Backup verificado com sucesso! Tamanho: $BACKUP_SIZE${RESET}"
else
    echo -e "${VERMELHO}[ERRO] Backup corrompido! Removendo arquivo inválido...${RESET}"
    rm -f "$BACKUP_FILE"
    exit 1
fi

# Limpeza automática: mantém apenas os últimos MAX_BACKUPS backups
echo -e "${AZUL}==> Verificando backups antigos (limite: $MAX_BACKUPS)...${RESET}"
BACKUP_COUNT=$(find "$BACKUPS_DIR" -name "tahoe_base__*.qcow2" | wc -l)

if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
    EXCESSO=$((BACKUP_COUNT - MAX_BACKUPS))
    echo -e "${AMARELO}==> Removendo $EXCESSO backup(s) antigo(s)...${RESET}"
    find "$BACKUPS_DIR" -name "tahoe_base__*.qcow2" \
        | sort \
        | head -n "$EXCESSO" \
        | while read -r OLD_BACKUP; do
            echo "    Removendo: $(basename "$OLD_BACKUP")"
            rm -f "$OLD_BACKUP"
        done
fi

# Exibe lista de backups disponíveis
echo ""
echo -e "${AZUL}Backups disponíveis em $BACKUPS_DIR:${RESET}"
find "$BACKUPS_DIR" -name "tahoe_base__*.qcow2" | sort | while read -r b; do
    SIZE=$(du -sh "$b" | awk '{print $1}')
    echo "  → $(basename "$b") ($SIZE)"
done

echo ""
echo -e "${VERDE}=========================================================="
echo " Backup concluído com segurança!"
echo " Para restaurar, use: ./reims restore"
echo -e "==========================================================${RESET}"
