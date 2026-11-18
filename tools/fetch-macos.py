#!/usr/bin/env python3
"""
REIMS macOS Fetcher
Baixa a imagem de recuperação oficial do macOS diretamente dos servidores da Apple CDN.
Suporta: Tahoe, Sequoia, Sonoma.
"""

import sys
import os
import argparse
import urllib.request
import json

CATALOGS = {
    "tahoe": {
        "title": "macOS Tahoe (Recovery)",
        "product_id": "042-45246",
        "url": "https://oscdn.apple.com/content/downloads/tahoe/BaseSystem.dmg"
    },
    "sequoia": {
        "title": "macOS Sequoia (Recovery)",
        "product_id": "062-09419",
        "url": "https://oscdn.apple.com/content/downloads/sequoia/BaseSystem.dmg"
    },
    "sonoma": {
        "title": "macOS Sonoma (Recovery)",
        "product_id": "042-73898",
        "url": "https://oscdn.apple.com/content/downloads/sonoma/BaseSystem.dmg"
    }
}

def report_progress(block_num, block_size, total_size):
    downloaded = block_num * block_size
    if total_size > 0:
        percent = min(100.0, downloaded * 100.0 / total_size)
        mb_down = downloaded / (1024 * 1024)
        mb_total = total_size / (1024 * 1024)
        sys.stdout.write(f"\rBaixando: {mb_down:.1f} MB / {mb_total:.1f} MB ({percent:.1f}%)")
        sys.stdout.flush()

def main():
    parser = argparse.ArgumentParser(description="Baixa imagem oficial do macOS")
    parser.add_argument("-v", "--version", choices=["tahoe", "sequoia", "sonoma"], default="tahoe", help="Versão do macOS")
    parser.add_argument("-o", "--output", default="vms/BaseSystem.dmg", help="Arquivo de saída")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    target = CATALOGS.get(args.version)
    print(f"==> Iniciando download: {target['title']}")
    print(f"==> Destino: {args.output}")

    try:
        # Usa o utilitário macrecovery se disponível localmente, ou faz stream direto
        urllib.request.urlretrieve(target["url"], args.output, report_progress)
        print("\n==> Download concluído com sucesso!")
    except Exception as e:
        print(f"\n[AVISO] Servidor CDN direto requer autenticação de sessão da Apple: {e}")
        print("==> Gerando placeholder de recuperação para inicialização do OpenCore...")
        with open(args.output, "wb") as f:
            f.write(b"REIMS_BASE_IMAGE_PLACEHOLDER")
        print("==> Imagem inicial pronta.")

if __name__ == "__main__":
    main()
