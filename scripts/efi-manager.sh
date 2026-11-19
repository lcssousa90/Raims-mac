#!/usr/bin/env bash
# ==============================================================================
# REIMS - Gerenciador Seguro de EFI / OpenCore / Kexts / NVRAM
# Subcomandos:
#   audit        -> Verifica OpenCore, kexts, hashes e NVRAM (seguro com VM ligada)
#   update-kexts -> Atualiza APENAS Graft/ReimsGraphics/RgfxGate preservando Wi-Fi/BT
# ==============================================================================

set -euo pipefail

VERDE="\e[1;32m"
AZUL="\e[1;34m"
AMARELO="\e[1;33m"
VERMELHO="\e[1;31m"
RESET="\e[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/reims.env" ] && source "$SCRIPT_DIR/reims.env"

ACAO="${1:-audit}"

if [ "$ACAO" = "--help" ] || [ "$ACAO" = "-h" ] || [ "$ACAO" = "help" ]; then
    echo "Uso: ./reims efi [audit|update-kexts]"
    echo "  audit         Audita opencore.qcow2 (cópia read-only, seguro com VM rodando)"
    echo "  update-kexts  Atualiza Graft, ReimsGraphics e RgfxGate de /root/reims-vgpu/guest/prebuilt"
    exit 0
fi

if [ "$EUID" -ne 0 ]; then
    echo -e "${VERMELHO}[ERRO] Execute com sudo para montar imagens qcow2 via qemu-nbd.${RESET}"
    exit 1
fi

CTL_OC="${REIMS_CTL_VM_DIR:-/root/.local/share/reims-ctl/vms/mac}/opencore.qcow2"
if [ "${USE_REIMS_CTL:-true}" = "true" ] && [ -f "$CTL_OC" ]; then
    OC_IMG="$CTL_OC"
else
    OC_IMG="$SCRIPT_DIR/${OPENCORE_IMG:-efi/OpenCore_Tahoe.img}"
fi

if [ ! -f "$OC_IMG" ]; then
    echo -e "${VERMELHO}[ERRO] Imagem OpenCore não encontrada em: $OC_IMG${RESET}"
    exit 1
fi

pick_free_nbd() {
    modprobe nbd max_part=8
    for idx in 0 1 2 3 4 5 6 7; do
        local dev="/dev/nbd${idx}"
        local sys="/sys/block/nbd${idx}"
        if [ -b "$dev" ] && [ ! -e "${sys}/pid" ] && [ "$(cat "${sys}/size" 2>/dev/null || echo 1)" = "0" ]; then
            echo "$dev"
            return 0
        fi
    done
    return 1
}

NBD_DEV=""
MNT_DIR="/tmp/reims_efi_mnt_$$"
TMP_QCOW2=""

cleanup() {
    sync || true
    if mountpoint -q "$MNT_DIR" 2>/dev/null; then
        umount "$MNT_DIR" 2>/dev/null || true
    fi
    if [ -n "$NBD_DEV" ]; then
        qemu-nbd -d "$NBD_DEV" >/dev/null 2>&1 || true
    fi
    rmdir "$MNT_DIR" 2>/dev/null || true
    if [ -n "$TMP_QCOW2" ] && [ -f "$TMP_QCOW2" ]; then
        rm -f "$TMP_QCOW2"
    fi
}
trap cleanup EXIT

case "$ACAO" in
    audit)
        echo -e "${AZUL}==> Auditando EFI em cópia segura de: $OC_IMG${RESET}"
        TMP_QCOW2="/tmp/oc_efi_audit_$$.qcow2"
        cp "$OC_IMG" "$TMP_QCOW2"

        echo -e "${AZUL}[1/3] Verificando integridade qcow2 (qemu-img check)...${RESET}"
        qemu-img check "$TMP_QCOW2"

        NBD_DEV=$(pick_free_nbd) || { echo -e "${VERMELHO}[ERRO] Nenhum /dev/nbd livre.${RESET}"; exit 1; }
        mkdir -p "$MNT_DIR"
        qemu-nbd -r -c "$NBD_DEV" "$TMP_QCOW2"
        sleep 1
        mount -o ro "${NBD_DEV}p1" "$MNT_DIR"

        echo -e "${AZUL}[2/3] Auditando config.plist, Kexts e NVRAM...${RESET}"
        python3 - "$MNT_DIR" << 'PY'
import hashlib, os, plistlib, sys

try:
    import tomllib
except ImportError:
    tomllib = None

mnt = sys.argv[1]
oc = os.path.join(mnt, "EFI", "OC")
cfg_path = os.path.join(oc, "config.plist")
k_dir = os.path.join(oc, "Kexts")

errors = 0
warnings = 0

if not os.path.isfile(cfg_path):
    print("ERRO: config.plist não encontrado!")
    sys.exit(1)

with open(cfg_path, "rb") as f:
    cfg = plistlib.load(f)

expected_set = {}
set_toml_path = "/root/reims-vgpu/guest/prebuilt/set.toml"
if tomllib and os.path.isfile(set_toml_path):
    with open(set_toml_path, "rb") as sf:
        data = tomllib.load(sf)
        for item in data.get("kext", []):
            expected_set[item["BundlePath"]] = item.get("sha256", "")

print("Kernel -> Add:")
for i, entry in enumerate(cfg.get("Kernel", {}).get("Add", [])):
    bp = entry.get("BundlePath", "")
    en = entry.get("Enabled", False)
    ep = entry.get("ExecutablePath", "")
    pp = entry.get("PlistPath", "")
    full_bp = os.path.join(k_dir, bp)
    full_ep = os.path.join(full_bp, ep) if ep else None
    full_pp = os.path.join(full_bp, pp) if pp else None

    if not os.path.isdir(full_bp):
        print(f"  [ERRO] [{i}] {bp}: diretório ausente")
        errors += 1
        continue
    if full_pp and not os.path.isfile(full_pp):
        print(f"  [ERRO] [{i}] {bp}: Info.plist ausente")
        errors += 1
        continue
    if full_ep and not os.path.isfile(full_ep):
        print(f"  [ERRO] [{i}] {bp}: executável ausente")
        errors += 1
        continue

    ver, bid = "?", "?"
    if full_pp:
        with open(full_pp, "rb") as pf:
            kpl = plistlib.load(pf)
            ver = str(kpl.get("CFBundleShortVersionString", "?"))
            bid = str(kpl.get("CFBundleIdentifier", "?"))
    sha = "-"
    if full_ep:
        with open(full_ep, "rb") as ef:
            sha = hashlib.sha256(ef.read()).hexdigest()

    status = "OK"
    if bp == "USBMap.kext" and en:
        status = "ERRO (USBMap.kext deve estar Enabled=False)"
        errors += 1
    if bp in expected_set and expected_set[bp] and sha != expected_set[bp]:
        status = f"AVISO (hash EFI {sha[:12]} != set.toml {expected_set[bp][:12]})"
        warnings += 1

    print(f"  [{i}] {bp:<28} Enabled={str(en):<5} Ver={ver:<8} SHA={sha[:12]} [{status}]")

apple_double = [x for x in sorted(os.listdir(k_dir)) if x.startswith("._")]
if apple_double:
    print(f"AVISO: Arquivos residuais AppleDouble encontrados em EFI/OC/Kexts: {apple_double}")
    warnings += 1
else:
    print("Higiene Kexts: sem arquivos residuais ._*")

guid = "7C436110-AB2A-4BBB-A880-FE41995C9F82"
nv_add = cfg.get("NVRAM", {}).get("Add", {}).get(guid, {})
nv_del = cfg.get("NVRAM", {}).get("Delete", {}).get(guid, [])
bt_info = nv_add.get("bluetoothInternalControllerInfo")
if isinstance(bt_info, bytes) and len(bt_info) == 14:
    print(f"NVRAM bluetoothInternalControllerInfo: OK (14 bytes = {bt_info.hex()})")
else:
    print(f"ERRO: bluetoothInternalControllerInfo inválido ({bt_info!r}) — Bluetooth exige 14 bytes!")
    errors += 1

if "bluetoothInternalControllerInfo" in nv_del:
    print("NVRAM Delete protection: OK (bluetoothInternalControllerInfo presente em NVRAM -> Delete)")
else:
    print("ERRO: bluetoothInternalControllerInfo ausente em NVRAM -> Delete!")
    errors += 1

print(f"Resumo Auditoria EFI: {errors} erro(s), {warnings} aviso(s)")
if errors > 0:
    sys.exit(1)
PY
        echo -e "${VERDE}[✓] Auditoria EFI concluída com sucesso.${RESET}"
        ;;

    update-kexts)
        if pidof qemu-system-x86_64 >/dev/null 2>&1; then
            echo -e "${VERMELHO}[ERRO] A VM está em execução! Pare a VM antes de alterar a EFI.${RESET}"
            exit 1
        fi

        SRC_KEXTS="/root/reims-vgpu/guest/prebuilt"
        for k in Graft.kext ReimsGraphics.kext RgfxGate.kext; do
            if [ ! -d "$SRC_KEXTS/$k" ]; then
                echo -e "${VERMELHO}[ERRO] Kext pré-compilada ausente: $SRC_KEXTS/$k${RESET}"
                exit 1
            fi
        done

        TS=$(date +%Y%m%d_%H%M%S)
        BAK="${OC_IMG}.bak_before_efi_update_${TS}"
        echo -e "${AZUL}==> Criando backup prévio: $BAK${RESET}"
        cp -a "$OC_IMG" "$BAK"

        NBD_DEV=$(pick_free_nbd) || { echo -e "${VERMELHO}[ERRO] Nenhum /dev/nbd livre.${RESET}"; exit 1; }
        mkdir -p "$MNT_DIR"
        qemu-nbd -c "$NBD_DEV" "$OC_IMG"
        sleep 1
        mount "${NBD_DEV}p1" "$MNT_DIR"

        echo -e "${AZUL}==> Atualizando Graft.kext, ReimsGraphics.kext e RgfxGate.kext...${RESET}"
        for k in Graft.kext ReimsGraphics.kext RgfxGate.kext; do
            rm -rf "$MNT_DIR/EFI/OC/Kexts/$k"
            cp -r "$SRC_KEXTS/$k" "$MNT_DIR/EFI/OC/Kexts/$k"
        done
        rm -f "$MNT_DIR"/EFI/OC/Kexts/._*.kext

        echo -e "${AZUL}==> Garantindo proteção NVRAM de 14 bytes do Bluetooth no config.plist...${RESET}"
        python3 - "$MNT_DIR/EFI/OC/config.plist" << 'PY'
import plistlib, sys

cfg_path = sys.argv[1]
with open(cfg_path, "rb") as f:
    cfg = plistlib.load(f)

guid = "7C436110-AB2A-4BBB-A880-FE41995C9F82"
nvram = cfg.setdefault("NVRAM", {})
nv_add = nvram.setdefault("Add", {}).setdefault(guid, {})
nv_del = nvram.setdefault("Delete", {}).setdefault(guid, [])

changed = False
bt = nv_add.get("bluetoothInternalControllerInfo")
if not isinstance(bt, bytes) or len(bt) != 14:
    nv_add["bluetoothInternalControllerInfo"] = b"\x00" * 14
    changed = True

if "bluetoothInternalControllerInfo" not in nv_del:
    nv_del.append("bluetoothInternalControllerInfo")
    changed = True

if changed:
    with open(cfg_path, "wb") as f:
        plistlib.dump(cfg, f)
    print("config.plist atualizado com proteção NVRAM de 14 bytes.")
else:
    print("config.plist já estava íntegro.")
PY
        sync
        umount "$MNT_DIR"
        qemu-nbd -d "$NBD_DEV" >/dev/null
        NBD_DEV=""
        rmdir "$MNT_DIR"

        echo -e "${AZUL}==> Validando imagem final com qemu-img check...${RESET}"
        qemu-img check "$OC_IMG"
        echo -e "${VERDE}[✓] Kexts gráficas atualizadas na EFI com segurança!${RESET}"
        ;;

    *)
        echo -e "${VERMELHO}[ERRO] Subcomando desconhecido: $ACAO (use audit ou update-kexts)${RESET}"
        exit 1
        ;;
esac
