#!/usr/bin/env bash
# ==============================================================================
# REIMS - Backup Atômico da VM e Imagem Base
# Suporta:
#   ./reims backup [motivo]       -> Backup comprimido da imagem base qcow2
#   ./reims backup golden [nome]  -> Snapshot completo reims-ctl (EFI + OVMF + vm.toml + QEMU)
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/reims.env" ] && source "$SCRIPT_DIR/reims.env"

if pidof qemu-system-x86_64 >/dev/null 2>&1; then
    echo -e "${VERMELHO}[ERRO] A VM está em execução! Pare a VM antes de fazer backup consistente.${RESET}"
    exit 1
fi

MODO="${1:-manual}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

if [ "$MODO" = "golden" ]; then
    TAG="${2:-}"
    SUFIXO=""
    [ -n "$TAG" ] && SUFIXO="_${TAG}"
    VM_DIR="${REIMS_CTL_VM_DIR:-/root/.local/share/reims-ctl/vms/mac}"

    if [ ! -d "$VM_DIR" ]; then
        echo -e "${VERMELHO}[ERRO] Diretório reims-ctl da VM não encontrado: $VM_DIR${RESET}"
        exit 1
    fi

    DEST="/root/backup_golden_${TIMESTAMP}${SUFIXO}"
    mkdir -p "$DEST"
    echo -e "${AZUL}==> Criando Golden Backup completo em: $DEST${RESET}"

    for f in opencore.qcow2 OVMF_CODE.fd OVMF_VARS.fd vm.toml; do
        [ -f "$VM_DIR/$f" ] && cp -a "$VM_DIR/$f" "$DEST/$f"
    done
    [ -f /root/.xinitrc ] && cp -a /root/.xinitrc "$DEST/.xinitrc"

    if [ -d /root/reims-vgpu/.git ]; then
        git -C /root/reims-vgpu rev-parse HEAD > "$DEST/reims_vgpu_commit.txt" 2>/dev/null || true
    fi
    if [ -L /root/.local/share/reims-ctl/qemu/current ]; then
        readlink -f /root/.local/share/reims-ctl/qemu/current > "$DEST/qemu_current_target.txt"
    fi

    if [ -f "$DEST/opencore.qcow2" ]; then
        qemu-img check "$DEST/opencore.qcow2"
    fi
    echo -e "${VERDE}[✓] Golden Backup criado com sucesso em: $DEST${RESET}"
    ls -lh "$DEST"
    exit 0
fi

VMS_DIR="$SCRIPT_DIR/vms"
BACKUPS_DIR="$SCRIPT_DIR/backups"
BASE_DISK="$SCRIPT_DIR/${DISCO_BASE:-vms/tahoe_base.qcow2}"
MAX_BACKUPS=3

mkdir -p "$BACKUPS_DIR"

echo -e "${AZUL}==> REIMS Backup — Proteção da Imagem Base${RESET}"

if [ ! -f "$BASE_DISK" ]; then
    echo -e "${VERMELHO}[ERRO] Imagem base não encontrada em: $BASE_DISK${RESET}"
    echo -e "       Para backup do ambiente reims-ctl (EFI + OVMF + QEMU), use: ./reims backup golden"
    exit 1
fi

BACKUP_FILE="$BACKUPS_DIR/tahoe_base__${TIMESTAMP}__${MODO}.qcow2"

echo -e "${AZUL}==> Criando backup: $(basename "$BACKUP_FILE")${RESET}"
echo -e "    Origem:  $BASE_DISK"
echo -e "    Destino: $BACKUP_FILE"
echo ""

BASE_SIZE_BYTES=$(du -sb "$BASE_DISK" | awk '{print $1}')
AVAILABLE_BYTES=$(df --output=avail -B1 "$BACKUPS_DIR" | tail -1)
REQUIRED_BYTES=$((BASE_SIZE_BYTES + 1073741824))

if [ "$AVAILABLE_BYTES" -lt "$REQUIRED_BYTES" ]; then
    BASE_SIZE_GB=$(awk "BEGIN {printf \"%.1f\", $BASE_SIZE_BYTES/1073741824}")
    AVAIL_GB=$(awk "BEGIN {printf \"%.1f\", $AVAILABLE_BYTES/1073741824}")
    echo -e "${VERMELHO}[ERRO] Espaço insuficiente: necessário ~${BASE_SIZE_GB}GB, disponível ${AVAIL_GB}GB${RESET}"
    exit 1
fi

echo -e "==> Comprimindo e copiando (isso pode levar alguns minutos)..."
qemu-img convert -f qcow2 -O qcow2 -c "$BASE_DISK" "$BACKUP_FILE"

if qemu-img check "$BACKUP_FILE" &>/dev/null; then
    BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | awk '{print $1}')
    echo -e "${VERDE}[✓] Backup verificado com sucesso! Tamanho: $BACKUP_SIZE${RESET}"
else
    echo -e "${VERMELHO}[ERRO] Backup corrompido! Removendo arquivo inválido...${RESET}"
    rm -f "$BACKUP_FILE"
    exit 1
fi

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
