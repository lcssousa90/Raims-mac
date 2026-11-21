#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

echo "==> [1/4] Limpando lock e backup parcial anterior..."
$SUDO rm -rf /Library/NullMoth/install.lock /Library/NullMoth/backup-*

URL_OK=""
for base in "http://10.0.2.2:8888" "http://192.168.18.10:8888"; do
  if curl -fsI --connect-timeout 5 "$base/SHA256SUMS" >/dev/null 2>&1; then
    URL_OK="$base"
    break
  fi
done

if [ -z "$URL_OK" ]; then
  echo "ERRO: Não foi possível conectar em http://10.0.2.2:8888 nem em http://192.168.18.10:8888"
  exit 1
fi

echo "==> [2/4] Verificando pacote em /tmp/nullmoth_install/pkgroot..."
if [ ! -f /tmp/nullmoth_install/pkgroot/sums_complete.sh ]; then
  echo "    Baixando e extraindo nullmoth-3.0-rtx3070-ready.tar.gz de $URL_OK..."
  mkdir -p /tmp/nullmoth_install
  cd /tmp/nullmoth_install
  curl -fsSL "$URL_OK/nullmoth-3.0-rtx3070-ready.tar.gz" -o nullmoth-3.0-rtx3070-ready.tar.gz
  tar -xzf nullmoth-3.0-rtx3070-ready.tar.gz
fi

cd /tmp/nullmoth_install/pkgroot

echo "==> [3/4] Atualizando install.sh e SHA256SUMS..."
curl -fsSL "$URL_OK/install.sh" -o install.sh.new
curl -fsSL "$URL_OK/SHA256SUMS" -o SHA256SUMS.new
mv -f install.sh.new install.sh
mv -f SHA256SUMS.new SHA256SUMS
chmod +x install.sh

shasum -a 256 --strict -c SHA256SUMS --quiet
echo "    SHA256SUMS OK!"

echo "==> [4/4] Executando install.sh corrigido..."
$SUDO ./install.sh
