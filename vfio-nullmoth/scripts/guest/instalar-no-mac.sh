#!/bin/bash
set -euo pipefail

WORK="/tmp/nullmoth_install"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

echo "==> [1/3] Baixando pacote NullMoth 3.0 pré-configurado (com firmware RTX 3070)..."
URL_OK=""
for base in "http://10.0.2.2:8888" "http://192.168.18.10:8888"; do
  if curl -fSL --connect-timeout 5 -o nullmoth-3.0-rtx3070-ready.tar.gz "$base/nullmoth-3.0-rtx3070-ready.tar.gz"; then
    URL_OK="$base"
    break
  fi
done

if [ -z "$URL_OK" ]; then
  echo "ERRO: Não foi possível baixar de http://10.0.2.2:8888 nem de http://192.168.18.10:8888"
  exit 1
fi

echo "==> [2/3] Extraindo e verificando SHA256SUMS..."
tar -xzf nullmoth-3.0-rtx3070-ready.tar.gz
cd pkgroot
shasum -a 256 --strict -c SHA256SUMS --quiet
echo "    SHA256SUMS OK!"

echo "==> [3/3] Executando instalador oficial NullMoth 3.0 (pedirá senha do macOS)..."
sudo ./install.sh

echo ""
echo "========================================================================"
echo " NullMoth 3.0 instalado no macOS!"
echo " Próximos passos:"
echo "  1. Se o macOS pedir permissão de extensão em Ajustes -> Privacidade e"
echo "     Segurança, clique em Permitir (não precisa reiniciar agora)."
echo "  2. Desligue o macOS normalmente (Menu Apple -> Desligar)."
echo "  3. No Linux, avise que desligou para ligarmos a RTX 3070 via VFIO!"
echo "========================================================================"
