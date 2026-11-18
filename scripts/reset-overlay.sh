#!/usr/bin/env bash
# ==============================================================================
# REIMS - Recuperação Instantânea da VM (Anti-Quebra)
# Descarta o disco temporário quebrado e recria uma camada limpa em 2 segundos.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

BASE_DISK="vms/tahoe_base.qcow2"
LIVE_DISK="vms/tahoe_live.qcow2"

if [ ! -f "$BASE_DISK" ]; then
    echo "[ERRO] A imagem base $BASE_DISK não existe. Não é possível restaurar."
    exit 1
fi

echo "==> Descartando camada temporária com alterações..."
rm -f "$LIVE_DISK"

echo "==> Criando nova camada dinâmica limpa a partir da base imutável..."
# BUG CORRIGIDO: usar caminho absoluto no backing file
qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2 "$LIVE_DISK"

echo "=========================================================="
echo " [OK] Sistema restaurado com sucesso para o estado limpo!"
echo " Você já pode iniciar a VM novamente com: ./reims start"
echo "=========================================================="
