#!/usr/bin/env bash
# ==============================================================================
# REIMS - Restauração de Backup (Imagem Base ou Golden Backup reims-ctl)
# Suporta:
#   ./reims restore         -> Restaura tahoe_base__*.qcow2
#   ./reims restore golden  -> Restaura EFI + OVMF_VARS + vm.toml + symlink QEMU
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
    echo -e "${VERMELHO}[ERRO] A VM está em execução! Pare a VM antes de restaurar backups.${RESET}"
    exit 1
fi

MODO="${1:-base}"

if [ "$MODO" = "golden" ]; then
    VM_DIR="${REIMS_CTL_VM_DIR:-/root/.local/share/reims-ctl/vms/mac}"
    GOLDENS=($(find /root -maxdepth 1 -type d -name "backup_golden_*" 2>/dev/null | sort -r))

    if [ "${#GOLDENS[@]}" -eq 0 ]; then
        echo -e "${VERMELHO}[ERRO] Nenhum diretório /root/backup_golden_* encontrado.${RESET}"
        exit 1
    fi

    echo -e "${AZUL}==> Golden Backups disponíveis:${RESET}"
    for i in "${!GOLDENS[@]}"; do
        COMMIT="?"
        [ -f "${GOLDENS[$i]}/reims_vgpu_commit.txt" ] && COMMIT=$(cat "${GOLDENS[$i]}/reims_vgpu_commit.txt" | head -c 9)
        echo "  [$((i+1))] ${GOLDENS[$i]} (reims-vgpu: $COMMIT)"
    done

    echo ""
    read -rp "Escolha o número do Golden Backup para restaurar [1]: " ESCOLHA
    ESCOLHA="${ESCOLHA:-1}"
    IDX=$((ESCOLHA-1))

    if [ "$IDX" -lt 0 ] || [ "$IDX" -ge "${#GOLDENS[@]}" ]; then
        echo -e "${VERMELHO}[ERRO] Opção inválida.${RESET}"
        exit 1
    fi

    ORIGEM="${GOLDENS[$IDX]}"
    echo -e "${AMARELO}[AVISO] Isso restaurará opencore.qcow2, OVMF_VARS.fd, vm.toml e symlink QEMU de:${RESET}"
    echo "  $ORIGEM"
    read -rp "Tem certeza? (s/N): " CONFIRMA
    [[ "$CONFIRMA" =~ ^[sS]$ ]] || { echo "Operação cancelada."; exit 0; }

    [ -f "$ORIGEM/opencore.qcow2" ] && cp -a "$ORIGEM/opencore.qcow2" "$VM_DIR/opencore.qcow2"
    [ -f "$ORIGEM/OVMF_VARS.fd" ]   && cp -a "$ORIGEM/OVMF_VARS.fd" "$VM_DIR/OVMF_VARS.fd"
    [ -f "$ORIGEM/vm.toml" ]        && cp -a "$ORIGEM/vm.toml" "$VM_DIR/vm.toml"
    [ -f "$ORIGEM/.xinitrc" ]       && cp -a "$ORIGEM/.xinitrc" /root/.xinitrc
    if [ -f "$ORIGEM/qemu_current_target.txt" ]; then
        TARGET=$(cat "$ORIGEM/qemu_current_target.txt")
        if [ -d "$TARGET" ]; then
            ln -sfn "$TARGET" /root/.local/share/reims-ctl/qemu/current
            echo -e "${VERDE}[OK] Symlink QEMU restaurado para: $TARGET${RESET}"
        else
            echo -e "${AMARELO}[AVISO] Build QEMU alvo não encontrada: $TARGET${RESET}"
        fi
    fi
    sync
    echo -e "${VERDE}[✓] Golden Backup restaurado! O backup original foi preservado em $ORIGEM.${RESET}"
    exit 0
fi

VMS_DIR="$SCRIPT_DIR/vms"
BACKUPS_DIR="$SCRIPT_DIR/backups"
BASE_DISK="$SCRIPT_DIR/${DISCO_BASE:-vms/tahoe_base.qcow2}"
LIVE_DISK="$SCRIPT_DIR/${DISCO_LIVE:-vms/tahoe_live.qcow2}"

echo -e "${AZUL}==> REIMS Restauração de Backup${RESET}"
echo ""

BACKUPS=($(find "$BACKUPS_DIR" -name "tahoe_base__*.qcow2" 2>/dev/null | sort -r))

if [ "${#BACKUPS[@]}" -eq 0 ]; then
    echo -e "${VERMELHO}[ERRO] Nenhum backup encontrado em $BACKUPS_DIR${RESET}"
    echo -e "       Execute: ./reims backup  (ou ./reims restore golden)"
    exit 1
fi

echo "Backups disponíveis:"
for i in "${!BACKUPS[@]}"; do
    SIZE=$(du -sh "${BACKUPS[$i]}" | awk '{print $1}')
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

if [ -f "$BASE_DISK" ]; then
    PRE_RESTORE="$BACKUPS_DIR/tahoe_base__$(date +%Y%m%d_%H%M%S)__pre-restore.qcow2"
    echo -e "${AZUL}==> Salvando base atual antes de restaurar em: $(basename "$PRE_RESTORE")${RESET}"
    qemu-img convert -f qcow2 -O qcow2 -c "$BASE_DISK" "$PRE_RESTORE"
fi

echo -e "${AZUL}==> Restaurando imagem base...${RESET}"
qemu-img convert -f qcow2 -O qcow2 "$BACKUP_ESCOLHIDO" "$BASE_DISK"

rm -f "$LIVE_DISK"
qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2 "$LIVE_DISK"

echo ""
echo -e "${VERDE}=========================================================="
echo " [✓] Restauração concluída com sucesso!"
echo " Execute: ./reims start  para iniciar o macOS Tahoe"
echo -e "==========================================================${RESET}"
