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

if [ ! -f /tmp/nullmoth_install/pkgroot/boost_daemon.sh ]; then
  echo "==> Baixando pacote NullMoth 3.0 para /tmp/nullmoth_install..."
  mkdir -p /tmp/nullmoth_install
  cd /tmp/nullmoth_install
  curl -fsSL "$URL_OK/nullmoth-3.0-rtx3070-ready.tar.gz" -o nullmoth-3.0-rtx3070-ready.tar.gz
  tar -xzf nullmoth-3.0-rtx3070-ready.tar.gz
fi

cd /tmp/nullmoth_install/pkgroot

echo "==> [1/2] Instalando GPU Boost Daemon (clock maximo P0 na RTX 3070)..."
$SUDO /bin/bash ./boost_daemon.sh install /tmp/nullmoth_install/pkgroot
$SUDO /bin/bash ./boost_daemon.sh status

echo "==> [2/2] Instalando Safari GPU Bundle Copy (WebGL / GPU no Safari)..."
$SUDO /bin/bash ./safari_gpu_copy.sh install /Library/GPUBundles/NVMTLDriver.bundle
$SUDO /bin/bash ./safari_gpu_copy.sh status

echo ""
echo "==> Concluido! Avise no chat para aplicarmos nvfbheads=4 + 8 vCPUs pinned + 12 GB RAM e reiniciar a VM."
