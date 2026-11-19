# REIMS - macOS Tahoe no seu Hardware

Projeto configurado especificamente para o seu hardware:
- **Processador:** AMD Ryzen 5 5600X (6 Cores / `Skylake-Client-noTSX-IBRS`)
- **Placa de Vídeo:** NVIDIA GeForce RTX 3070 (Aceleração Paravirtualizada `reims-vgpu` via Vulkan, ou modo alternativo VFIO Passthrough com NullMoth)
- **Memória:** 10 GB dedicados ao macOS Tahoe (`memory-backend-memfd` + `/dev/udmabuf` zero-copy DMA)
- **Rede & Bluetooth:** Intel Wi-Fi 6 AX200 (`05:00.0`, `vfio-pci`) + Intel Bluetooth AX200 (`8087:0029`, NVRAM 14 bytes)
- **Armazenamento:** SSD NVMe com TRIM nativo (`discard=unmap`) e orquestração via `reims-ctl`

---

## Como Usar no Debian

1. **Acesse a pasta do projeto:**
   ```bash
   cd /root/Raims-mac   # ou seu diretório clonado
   ```

2. **Primeira vez — Preparar o Host (instala dependências, sysctl, `udmabuf <= 1024`, linger PipeWire, VFIO/Bluetooth AX200 e copia OVMF):**
   ```bash
   sudo ./reims setup
   ```

3. **Verificar a saúde do sistema (inclui teste real de `ioctl` no `udmabuf` e PipeWire):**
   ```bash
   sudo ./reims doctor
   sudo ./reims preflight
   ```

4. **Auditar ou atualizar apenas as kexts gráficas na EFI (preservando Wi-Fi/Bluetooth/USB):**
   ```bash
   sudo ./reims efi audit
   sudo ./reims efi update-kexts   # com a VM desligada
   ```

5. **Iniciar o macOS Tahoe:**
   ```bash
   sudo ./reims start
   # ou simplesmente: sudo ./reims (menu visual)
   ```

6. **Backups Completos e Rollback de Emergência:**
   ```bash
   sudo ./reims backup golden      # Salva opencore.qcow2, OVMF, vm.toml e symlink QEMU
   sudo ./reims restore golden     # Restaura um Golden Backup
   sudo ./reims rollback           # Reverte imediatamente via /root/reverte-tudo.sh
   ```

7. **Painel Web no Cockpit (Gerenciamento pelo Navegador):**
   ```bash
   sudo ./reims cockpit
   ```
   *Abre o painel em `https://<ip-do-debian>:9090` com monitor de GPU, controle limpo da VM e logs.*

---

## Principais Correções Aplicadas (v1.2 — Produção)

| # | Problema | Arquivo(s) | Correção |
|---|---|---|---|
| 1 | Overflow de 32-bit em `udmabuf` (`size_limit_mb=8192`) quebrava todo zero-copy DMA com `EINVAL` | `setup-host.sh`, `preflight.sh`, `reims.env` | Fixado `size_limit_mb=1024` (`<= 2047`) + teste real de `ioctl(UDMABUF_CREATE)` |
| 2 | `XDG_RUNTIME_DIR=/run/user/0` impedia QEMU de conectar ao PipeWire do usuário `mac` (`/run/user/1000`) | `run-tahoe.sh`, `preflight.sh` | Detecção automática do socket `/run/user/1000/pipewire-0` + `loginctl enable-linger` |
| 3 | QEMU padrão sem `isa-applesmc`, `smbios`, `ich9-ahci` ou `qemu-xhci` limitado a 14 portas | `run-tahoe.sh`, `reims.env` | Integração direta com `reims-ctl` + fallback standalone completo com `nvme` (`discard=unmap`) e `p2=7,p3=7` |
| 4 | `backing file` relativo quebrava `qemu-img create` em `run-tahoe.sh` e `reset-overlay.sh` | `run-tahoe.sh`, `reset-overlay.sh` | Caminho absoluto `"$SCRIPT_DIR/$DISCO_BASE"` + bloqueio se VM estiver ligada |
| 5 | Falta de auditoria/atualização segura de EFI (risco de perder Bluetooth 14-byte NVRAM e Wi-Fi) | `scripts/efi-manager.sh`, `reims` | Novo `./reims efi audit` e `update-kexts` validando `set.toml` e NVRAM 14 bytes |
| 6 | Plugin Cockpit ignorava `/root`, matava VM com `pkill` e falhava no locale `pt_BR` | `cockpit-plugin/app.js`, `monitor.sh` | Busca em `/root`, shutdown limpo com `reims-ctl stop`, `pidof`, `LC_ALL=C` e remoção do `bc` em `monitor.sh` |
