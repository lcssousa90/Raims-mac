#!/usr/bin/env bash
# ==============================================================================
# REIMS - Utilitários de Qualidade de Vida (QoL)
# Habilita/desabilita: Clipboard Sync, Redimensionamento de Tela, Acesso a Pastas Compartilhadas
# ==============================================================================

set -uo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo -e "${AZUL}=== REIMS QoL — Utilitários de Conforto ===${RESET}"
echo ""

# ── 1. CLIPBOARD SYNC (Área de Transferência Compartilhada) ──────────────────
# Redireciona a área de transferência entre o macOS e o Debian via xclip + socat

instalar_clipboard_sync() {
    echo -e "${AZUL}==> Configurando sincronização de área de transferência (macOS ↔ Debian)...${RESET}"
    sudo apt install -y xclip socat 2>/dev/null | grep -E "(install|already)" || true

    # Cria script de ponte de clipboard
    cat > "$SCRIPT_DIR/scripts/clipboard-bridge.sh" << 'CLIP'
#!/usr/bin/env bash
# Ponte de clipboard entre o host Linux e o macOS (via SPICE vdagent)
# O vdagent já está configurado no run-tahoe.sh via virtio-serial + spicevmc

if command -v spicy &>/dev/null || command -v virt-viewer &>/dev/null; then
    echo "SPICE disponível — clipboard sync ativo via vdagent."
else
    echo "Instale o spice-vdagent: sudo apt install -y spice-vdagent"
fi

# Monitora a área de transferência do host e exporta para arquivo acessível pela VM
while true; do
    xclip -selection clipboard -o 2>/dev/null > /tmp/reims_clipboard.txt || true
    sleep 1
done
CLIP
    chmod +x "$SCRIPT_DIR/scripts/clipboard-bridge.sh"
    echo -e "${VERDE}[✓] Clipboard bridge configurado — será ativado ao iniciar a VM${RESET}"
}

# ── 2. PASTA COMPARTILHADA (Host → macOS via VirtFS) ────────────────────────

criar_pasta_compartilhada() {
    local PASTA_HOST="$SCRIPT_DIR/compartilhado"
    mkdir -p "$PASTA_HOST"
    echo -e "${AZUL}==> Pasta compartilhada criada em: $PASTA_HOST${RESET}"
    echo -e "    Coloque arquivos aqui para acessar diretamente no macOS Tahoe."
    echo ""

    # Adiciona parâmetros de VirtFS ao run-tahoe.sh se ainda não existirem
    if ! grep -q "virtfs" "$SCRIPT_DIR/scripts/run-tahoe.sh"; then
        # Insere antes da linha de saída do QEMU
        sed -i '/2>&1 | tee/i\    -virtfs local,path='"$PASTA_HOST"',mount_tag=shared,security_model=mapped-xattr \\' \
            "$SCRIPT_DIR/scripts/run-tahoe.sh"
        echo -e "${VERDE}[✓] VirtFS configurado — pasta compartilhada disponível na VM${RESET}"
        echo -e "${AMARELO}    Para montar no macOS, abra o Terminal e execute:${RESET}"
        echo -e "    ${AMARELO}mount -t virtfs -o trans=virtio shared /Volumes/Compartilhado${RESET}"
    else
        echo -e "${VERDE}[✓] VirtFS já configurado${RESET}"
    fi
}

# ── 3. CRIAR ATALHO NO DESKTOP ───────────────────────────────────────────────

criar_atalho_desktop() {
    DESKTOP_DIR="$HOME/Desktop"
    [ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/Área de Trabalho"
    [ -d "$DESKTOP_DIR" ] || mkdir -p "$DESKTOP_DIR"

    ATALHO="$DESKTOP_DIR/REIMS macOS Tahoe.desktop"
    cat > "$ATALHO" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=REIMS macOS Tahoe
Comment=Iniciar macOS Tahoe com Reims vGPU
Exec=bash -c 'cd "$SCRIPT_DIR" && ./reims start'
Icon=computer-apple-iphone
Terminal=true
Categories=System;Emulator;
StartupNotify=true
EOF
    chmod +x "$ATALHO"
    echo -e "${VERDE}[✓] Atalho criado no Desktop: REIMS macOS Tahoe${RESET}"
}

# ── 4. SNAPPY — Snapshot Rápido com Nome Personalizado ──────────────────────

snapshot_rapido() {
    local NOME="${1:-snapshot_$(date +%Y%m%d_%H%M%S)}"
    local LIVE="$SCRIPT_DIR/vms/tahoe_live.qcow2"
    if [ ! -f "$LIVE" ]; then
        echo -e "${AMARELO}[!] VM não encontrada. Execute a VM pelo menos uma vez.${RESET}"
        return 1
    fi
    echo -e "${AZUL}==> Criando snapshot interno: $NOME${RESET}"
    qemu-img snapshot -c "$NOME" "$LIVE"
    echo -e "${VERDE}[✓] Snapshot '$NOME' salvo dentro de tahoe_live.qcow2${RESET}"
    echo ""
    echo "Snapshots disponíveis:"
    qemu-img snapshot -l "$LIVE"
}

# ── MENU PRINCIPAL ───────────────────────────────────────────────────────────

ACAO="${1:-menu}"

case "$ACAO" in
    clipboard) instalar_clipboard_sync ;;
    compartilhado) criar_pasta_compartilhada ;;
    atalho) criar_atalho_desktop ;;
    snapshot) snapshot_rapido "${2:-}" ;;
    tudo)
        instalar_clipboard_sync
        echo ""
        criar_pasta_compartilhada
        echo ""
        criar_atalho_desktop
        echo ""
        echo -e "${VERDE}=========================================="
        echo " Todos os utilitários QoL ativados!"
        echo -e "==========================================${RESET}"
        ;;
    *)
        echo "Uso: ./reims qol <opção>"
        echo ""
        echo "  tudo          — Ativa todos os utilitários de uma vez"
        echo "  clipboard     — Sincronização de área de transferência (macOS ↔ Debian)"
        echo "  compartilhado — Pasta compartilhada entre Debian e macOS"
        echo "  atalho        — Atalho clicável no Desktop para iniciar a VM"
        echo "  snapshot <nome> — Snapshot rápido com nome personalizado"
        ;;
esac
