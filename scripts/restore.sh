#!/usr/bin/env bash
# ==============================================================================
# REIMS - Restaurar Backup de Imagem Base
# Lista os backups disponíveis e permite restaurar um deles de forma segura.
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
LIVE_DISK="$VMS_DIR/tahoe_live.qcow2"

echo -e "${AZUL}==> REIMS Restauração de Backup${RESET}"
echo ""

# Lista backups disponíveis
BACKUPS=($(find "$BACKUPS_DIR" -name "tahoe_base__*.qcow2" 2>/dev/null | sort -r))

if [ "${#BACKUPS[@]}" -eq 0 ]; then
    echo -e "${VERMELHO}[ERRO] Nenhum backup encontrado em $BACKUPS_DIR${RESET}"
    echo -e "       Execute: ./reims backup  para criar um backup agora."
    exit 1
fi

echo "Backups disponíveis:"
for i in "${!BACKUPS[@]}"; do
    SIZE=$(du -sh "${BACKUPS[$i]}" | awk '{print $1}')
    DATE=$(basename "${BACKUPS[$i]}" | grep -oP '\d{8}_\d{6}' | sed 's/\(\d\{4\}\)\(\d\{2\}\)\(\d\{2\}\)_\(\d\{2\}\)\(\d\{2\}\)\(\d\{2\}\)/\1-\2-\3 \4:\5:\6/')
    echo "  [$((i+1))] $(basename "${BACKUPS[$i]}") ($SIZE)"
done

echo ""
read -rp "Escolha o número do backup para restaurar [1]: " ESCOLHA
ESCOLHA="${ESCOLHA:-1}"
IDX=$((ESCOLHA-1))

if [ "$IDX" -lt 0 ] || [ "$IDX" -ge "${#BACKUPS[@]}" ]; then
    echo -e "${VERMELHO}[ERRO] Opção inválida.${RESET}"
    exit 1
fi

BACKUP_ESCOLHIDO="${BACKUPS[$IDX]}"
echo ""
echo -e "${AMARELO}[AVISO] Isso vai substituir a imagem base atual por:${RESET}"
echo "  $(basename "$BACKUP_ESCOLHIDO")"
read -rp "Tem certeza? (s/N): " CONFIRMA
[[ "$CONFIRMA" =~ ^[sS]$ ]] || { echo "Operação cancelada."; exit 0; }

# Faz backup da base atual antes de restaurar
if [ -f "$BASE_DISK" ]; then
    PRE_RESTORE="$BACKUPS_DIR/tahoe_base__$(date +%Y%m%d_%H%M%S)__pre-restore.qcow2"
    echo -e "${AZUL}==> Salvando base atual antes de restaurar em: $(basename "$PRE_RESTORE")${RESET}"
    qemu-img convert -f qcow2 -O qcow2 -c "$BASE_DISK" "$PRE_RESTORE"
fi

# Restaura o backup escolhido
echo -e "${AZUL}==> Restaurando imagem base...${RESET}"
qemu-img convert -f qcow2 -O qcow2 "$BACKUP_ESCOLHIDO" "$BASE_DISK"

# Recria o overlay live automaticamente
rm -f "$LIVE_DISK"
qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2 "$LIVE_DISK"

echo ""
echo -e "${VERDE}=========================================================="
echo " [✓] Restauração concluída com sucesso!"
echo " Execute: ./reims start  para iniciar o macOS Tahoe"
echo -e "==========================================================${RESET}"
