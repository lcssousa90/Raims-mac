#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

URL_OK=""
for base in "http://10.0.2.2:8888" "http://192.168.18.10:8888"; do
  if curl -fsI --connect-timeout 5 "$base/SHA256SUMS" >/dev/null 2>&1; then
    URL_OK="$base"
    break
  fi
done

if [ -z "$URL_OK" ]; then
  echo "ERRO: Servidor HTTP na porta 8888 inacessivel."
  exit 1
fi

if [ ! -f /tmp/nullmoth_install/pkgroot/dlss_fetch.sh ]; then
  echo "==> Baixando pacote NullMoth 3.0 para /tmp/nullmoth_install..."
  mkdir -p /tmp/nullmoth_install
  cd /tmp/nullmoth_install
  curl -fsSL "$URL_OK/nullmoth-3.0-rtx3070-ready.tar.gz" -o nullmoth-3.0-rtx3070-ready.tar.gz
  tar -xzf nullmoth-3.0-rtx3070-ready.tar.gz
fi

PKGROOT="/tmp/nullmoth_install/pkgroot"
cd "$PKGROOT"

echo ""
echo "==> [1/4] Verificando GPU Boost Daemon (nvmtl-boost / gpuboost=1)..."
BOOST_STATUS=$($SUDO /bin/bash ./boost_daemon.sh status 2>/dev/null || true)
if echo "$BOOST_STATUS" | grep -q "^not installed"; then
  $SUDO /bin/bash ./boost_daemon.sh install "$PKGROOT"
elif ! echo "$BOOST_STATUS" | grep -q "gpuboost=1"; then
  $SUDO /bin/bash ./boost_daemon.sh set on || $SUDO /bin/bash ./boost_daemon.sh install "$PKGROOT"
fi
$SUDO /bin/bash ./boost_daemon.sh status || true
pgrep -fl nvmtl-boost || true

echo ""
echo "==> [2/4] Aplicando tuning NullMoth 3.0 em /Library/GPUBundles/nvmtl/nvrm610.conf..."
NVCONF="/Library/GPUBundles/nvmtl/nvrm610.conf"
if [ ! -f "$NVCONF" ]; then
  echo "ERRO: $NVCONF nao encontrado. Verifique se o NullMoth 3.0 esta instalado."
  exit 1
fi
if [ ! -f "${NVCONF}.bak" ]; then
  $SUDO cp -p "$NVCONF" "${NVCONF}.bak"
fi
TMP_CONF=$(mktemp /tmp/nvrm610.XXXXXX)
$SUDO awk '
  /^# --- my settings, kept on update ---$/ { skip=1; next }
  /^# --- end my settings ---$/ { skip=0; next }
  !skip { print }
' "$NVCONF" > "$TMP_CONF"
cat << 'CONF' >> "$TMP_CONF"
# --- my settings, kept on update ---
NVMTL_SHARED_VRAM=1
NVMTL_SHARED_POOL_VRAM=1
NVMTL_WS_FULL=1
NVMTL_GAME_GPU_PRIORITY=1
NVMTL_GAME_LOWER_BACKGROUND=1
NVMTL_HWRT=1
NVMTL_PRETRANSLATE=1
NVMTL_PRETRANSLATE_THREADS=4
NVMTL_PIPELINE_THREADS=6
# --- end my settings ---
CONF
$SUDO cp "$TMP_CONF" "$NVCONF"
rm -f "$TMP_CONF"
$SUDO chown root:wheel "$NVCONF"
$SUDO chmod 644 "$NVCONF"

echo ""
echo "==> [3/4] Instalando Vulkan NVK 1.4 nativo + Loader (libvulkan.1.dylib)..."
$SUDO /bin/bash "$PKGROOT/Library/NullMoth/vulkan/vulkan-for-apps.sh" \
  --install --with-loader "$PKGROOT/Library/NullMoth/vulkan/libvulkan.1.dylib"
/bin/bash "$PKGROOT/Library/NullMoth/vulkan/vulkan-for-apps.sh" --status

echo ""
echo "==> [4/4] Instalando NVIDIA DLSS 4 / 4.5 + Frame Generation + Ray Reconstruction (sm_86)..."
echo "    (Baixa arquivos oficiais ~550 MB da NVIDIA/PyPI, valida SHA-256 e compila kernels RTX 3070)"
if ! $SUDO /bin/bash "$PKGROOT/dlss_fetch.sh" --yes; then
  echo "AVISO: dlss_fetch.sh falhou (verifique conexao com a internet). Voce pode tentar novamente depois com:"
  echo "  sudo /bin/bash $PKGROOT/dlss_fetch.sh --yes"
fi

echo ""
echo "==================== RESUMO DE VERIFICACAO ===================="
echo "--- $NVCONF ---"
cat "$NVCONF"
echo "--- /Library/NullMoth/dlss/manifest.txt ---"
cat /Library/NullMoth/dlss/manifest.txt 2>/dev/null || echo "DLSS nao instalado"
echo "--- sysctl debug.nvaccelfb ---"
sysctl debug.nvaccelfb 2>/dev/null || true
echo "--- kexts NullMoth / Bluetooth / USBMap ---"
kextstat | grep -iE "nullmoth|nvrm|intel|blue|usbmap" || true
echo "==============================================================="
echo ""
echo "==> Concluido no macOS!"
echo "    Avise no chat (ou reinicie a VM / PC para entrar na BIOS ASUS e ativar"
echo "    Core Performance Boost = Auto/Enabled para liberar 4.65+ GHz no 5600X)."
echo "    Na proxima inicializacao da VM, todas as configuracoes da RTX 3070"
echo "    e a nova configuracao protegida de Bluetooth serao ativadas juntas."
