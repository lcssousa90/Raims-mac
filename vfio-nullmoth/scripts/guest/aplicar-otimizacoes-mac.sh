#!/usr/bin/env bash
set -euo pipefail

echo "========================================================================"
echo " NullMoth / Hackintosh VM - Correcoes de GPU, Safari, Rede e Cache Brave"
echo "========================================================================"
echo "Este script aplica os ajustes do lado do macOS de forma segura e idempotente."
echo "Se solicitado, digite a senha do macOS (usuario lucasvieira)."
echo ""

TARGET_USER="${SUDO_USER:-${USER:-lucasvieira}}"
TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
if [ -z "$TARGET_HOME" ] || [ ! -d "$TARGET_HOME" ]; then
  TARGET_HOME="/Users/lucasvieira"
fi

sudo -v

NVMTL_DIR="/Library/GPUBundles/nvmtl"
CONF="$NVMTL_DIR/nvrm610.conf"
CONF_BAK="$NVMTL_DIR/nvrm610.conf.bak"
SAFARI_HELPER="/Library/NullMoth/safari_gpu_copy.sh"

echo "==> [1/7] Restaurando $CONF estavel do NullMoth..."
sudo mkdir -p /Library/NullMoth
if [ -f "$CONF" ]; then
  BK_PRE="/Library/NullMoth/nvrm610.conf.pre_fix_$(date +%Y%m%d_%H%M%S)"
  sudo cp -a "$CONF" "$BK_PRE"
  echo "    Backup criado em $BK_PRE"
fi
if [ -f "$CONF_BAK" ]; then
  sudo cp -f "$CONF_BAK" "$CONF"
  echo "    Restaurado a partir de $CONF_BAK"
else
  sudo tee "$CONF" >/dev/null <<'CFG'
NVMTL_VRAM_WS_NONIMAGE_MB=0
NVMTL_VRAM_HEADROOM_MB=256
NVMTL_RES2_WS=1
NVMTL_GSUB_HOSTPTR_LIFT=1
NVMTL_NAK_ARR_SCRATCH=0
CFG
  echo "    Escrita configuracao padrao estavel em $CONF"
fi
sudo chown root:wheel "$CONF"
sudo chmod 644 "$CONF"

echo "==> [2/7] Verificando permissoes de aircache/spvcache e gpuboost=1..."
for cache_dir in "$NVMTL_DIR/aircache" "$NVMTL_DIR/spvcache"; do
  sudo mkdir -p "$cache_dir"
  sudo chown _windowserver:wheel "$cache_dir"
  sudo chmod 755 "$cache_dir"
done
printf 'gpuboost=1\n' | sudo tee /Library/NullMoth/gpuboost >/dev/null
sudo chown root:wheel /Library/NullMoth/gpuboost
sudo chmod 644 /Library/NullMoth/gpuboost
ls -ld "$NVMTL_DIR/aircache" "$NVMTL_DIR/spvcache" /Library/NullMoth/gpuboost

echo "==> [3/7] Verificando sobra /Library/GPUBundles/reims-graphics.bundle..."
if [ -e /Library/GPUBundles/reims-graphics.bundle ]; then
  REIMS_DST="/Library/NullMoth/backup-reims-graphics.bundle"
  if [ -e "$REIMS_DST" ]; then
    REIMS_DST="${REIMS_DST}.$(date +%Y%m%d_%H%M%S)"
  fi
  sudo mv /Library/GPUBundles/reims-graphics.bundle "$REIMS_DST"
  echo "    Movido para $REIMS_DST"
else
  echo "    Ja removido de /Library/GPUBundles."
fi

echo "==> [4/7] Instalando copia da GPU para Safari/WebKit (safari_gpu_copy.sh)..."
if [ -f /tmp/nullmoth_install/pkgroot/safari_gpu_copy.sh ]; then
  sudo cp -f /tmp/nullmoth_install/pkgroot/safari_gpu_copy.sh "$SAFARI_HELPER"
  sudo chown root:wheel "$SAFARI_HELPER"
  sudo chmod 755 "$SAFARI_HELPER"
fi
if [ -f "$SAFARI_HELPER" ]; then
  sudo bash "$SAFARI_HELPER" install || true
  SAFARI_STATUS="$(sudo bash "$SAFARI_HELPER" status 2>&1 || true)"
  echo "    Status Safari GPU copy: $SAFARI_STATUS"
else
  SAFARI_STATUS="safari_gpu_copy.sh nao encontrado (aviso, nao fatal)"
  echo "    AVISO: $SAFARI_STATUS"
fi

echo "==> [5/7] Limpando relatorios antigos de crash do bluetoothd..."
sudo find /Library/Logs/DiagnosticReports -maxdepth 1 \
  \( -name 'ExcUserFault_bluetoothd*.ips' -o -name 'bluetoothd*.ips' \) \
  -delete 2>/dev/null || true
echo "    DiagnosticReports do bluetoothd limpos."

echo "==> [6/7] Priorizando Wi-Fi (Intel AX200) acima da Ethernet (QEMU SLIRP)..."
ALL_SVCS=()
HAS_WIFI=0
HAS_ETH=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    "An asterisk"*) continue ;;
  esac
  svc="${line#\*}"
  if [ "$svc" = "Wi-Fi" ]; then
    HAS_WIFI=1
  elif [ "$svc" = "Ethernet" ]; then
    HAS_ETH=1
  else
    ALL_SVCS+=("$svc")
  fi
done < <(networksetup -listallnetworkservices)

ORDER=()
[ "$HAS_WIFI" -eq 1 ] && ORDER+=("Wi-Fi")
[ "$HAS_ETH" -eq 1 ] && ORDER+=("Ethernet")
if [ "${#ALL_SVCS[@]}" -gt 0 ]; then
  ORDER+=("${ALL_SVCS[@]}")
fi
if [ "${#ORDER[@]}" -gt 0 ]; then
  sudo networksetup -ordernetworkservices "${ORDER[@]}"
fi
networksetup -listnetworkserviceorder

echo "==> [7/7] Fechando Brave Browser e limpando caches de GPU/Dawn..."
if pgrep -x "Brave Browser" >/dev/null 2>&1; then
  if [ "$(id -un)" = "$TARGET_USER" ]; then
    osascript -e 'tell application "Brave Browser" to quit' 2>/dev/null || true
  fi
  for _wait in 1 2 3 4 5 6; do
    pgrep -x "Brave Browser" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -x "Brave Browser" >/dev/null 2>&1; then
    pkill -x "Brave Browser" 2>/dev/null || true
    sleep 0.5
  fi
fi

BRAVE_BASE="$TARGET_HOME/Library/Application Support/BraveSoftware/Brave-Browser"
rm -rf "$BRAVE_BASE/GraphiteDawnCache" "$BRAVE_BASE/Default/GPUCache"
echo "    Removidos: $BRAVE_BASE/GraphiteDawnCache e $BRAVE_BASE/Default/GPUCache"

echo ""
echo "========================================================================"
echo " RESUMO DAS ALTERACOES NO MACOS"
echo "========================================================================"
echo "--- $CONF ---"
cat "$CONF"
echo "--- /Library/GPUBundles ---"
ls -la /Library/GPUBundles
echo "--- Safari GPU copy ---"
echo "$SAFARI_STATUS"
echo "--- Ordem de rede ---"
networksetup -listnetworkserviceorder | sed -n '1,12p'
echo ""
echo "PROXIMOS PASSOS:"
echo "  1. Desligue o macOS normalmente (Menu Apple -> Desligar)."
echo "  2. Reinicie o PC fisico e entre na BIOS (Del/F2):"
echo "     - Ative Core Performance Boost = Auto / Enabled"
echo "     - Ative Global C-state Control = Enabled / Auto"
echo "     Salve e inicie o Linux normalmente."
echo "  3. Quando a VM subir, teste teclado sem fio, Bluetooth, Wi-Fi e littleprince.dev!"
echo "========================================================================"
