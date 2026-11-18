# REIMS - macOS Tahoe no seu Hardware

Projeto configurado especificamente para o seu hardware:
- **Processador:** AMD Ryzen 5 5600X (4 Cores / 8 Threads dedicados à VM)
- **Placa de Vídeo:** NVIDIA GeForce RTX 3070 (Aceleração Paravirtualizada Reims vGPU com Vulkan)
- **Memória:** 10 GB alocados para o Tahoe
- **Armazenamento:** SSD NVMe com arquitetura de camada imutável (*Backing File*)

---

## Como Usar no Debian

1. **Acesse esta pasta pelo terminal do Debian:**
   ```bash
   cd /mnt/windows/Users/lcsso/reims-mac
   chmod +x reims scripts/*.sh tools/*.sh
   ```

2. **Primeira vez - Preparar o Host (instala drivers, copia OVMF automaticamente):**
   ```bash
   ./reims setup
   ```

3. **Verificar a saúde do sistema (KVM, udmabuf e Vulkan):**
   ```bash
   ./reims doctor
   ```

4. **Baixar imagem oficial do macOS Tahoe:**
   ```bash
   ./reims create
   ```

5. **Iniciar o macOS Tahoe:**
   ```bash
   ./reims start
   # ou simplesmente: ./reims (para abrir o menu visual)
   ```

6. **Painel Web no Cockpit (Gerenciamento pelo Navegador):**
   ```bash
   ./reims cockpit
   ```
   *Abre o painel em `https://<ip-do-debian>:9090` com monitor de GPU, controle de VM e logs em tempo real.*

7. **Caso uma atualização quebre o macOS (Restauração Instantânea):**
   ```bash
   ./reims reset
   ```
   *O comando descarta a camada temporária quebrada e recria o sistema limpo em 2 segundos.*

---

## Bugs Corrigidos na Auditoria (v1.1)

| # | Bug | Arquivo | Correção |
|---|---|---|---|
| 1 | `backing file` com caminho relativo quebrava quando rodado de diretório diferente | `run-tahoe.sh`, `reset-overlay.sh` | Substituído por variável `$BASE_DISK` com caminho absoluto |
| 2 | `-machine memory-backend=mem0` é sintaxe inválida no QEMU atual | `run-tahoe.sh` | Substituído por `-numa node,memdev=mem0` (correto para QEMU 7+) |
| 3 | Áudio com `-device ich9-intel-hda -device hda-output` em linha única quebra o parser de argumentos | `run-tahoe.sh` | Separado em duas linhas com `\` |
| 4 | USB/mouse/teclado não inicializavam dentro do macOS | `run-tahoe.sh` | Adicionado controlador XHCI USB 3.0 com teclado e tablet |
| 5 | `sudo -v` com `set -e` ativo encerrava o script prematuramente se a senha expirasse | `setup-host.sh` | Substituído por `sudo true` |
| 6 | Dependências SDL2 e Pixman não declaradas (necessárias para `-display sdl,gl=on`) | `setup-host.sh` | Adicionado `libsdl2-2.0-0` e `libpixman-1-0` |
| 7 | OVMF precisava ser copiado manualmente para `efi/` antes de rodar | `setup-host.sh` | O setup agora detecta e copia automaticamente |
| 8 | Pastas `vms/` e `efi/` inexistentes causariam erro na primeira execução | Estrutura | Pastas criadas com `README.txt` explicativo |

