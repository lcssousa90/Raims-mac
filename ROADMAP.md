# REIMS macOS Tahoe — Roadmap de Implementação

> **Hardware Alvo:** AMD Ryzen 5 5600X | NVIDIA RTX 3070 | 16 GB RAM | SSD NVMe 2 TB  
> **Sistema Host:** Debian 13 Trixie (ou Ubuntu 24.04 LTS)  
> **Objetivo:** macOS Tahoe como sistema principal, Debian como backend invisível.

---

## ✅ Fase 1 — Base, Integridade e Produção (IMPLEMENTADO)

| # | Funcionalidade | Arquivo | Status |
|---|---|---|---|
| 1.1 | Instalador blindado sem sobrescrever `sources.list` | `tools/setup-host.sh` | ✅ Pronto |
| 1.2 | Ativação de KVM, `udmabuf` (`size_limit_mb=1024`), `vm.max_map_count=4194304` e linger PipeWire | `tools/setup-host.sh` | ✅ Pronto |
| 1.3 | Isolamento Intel AX200 (Wi-Fi `vfio-pci` + blacklist Bluetooth no host) | `tools/setup-host.sh` | ✅ Pronto |
| 1.4 | Integração com `reims-ctl` + fallback QEMU completo com NVMe TRIM (`discard=unmap`) | `scripts/run-tahoe.sh` | ✅ Pronto |
| 1.5 | Pré-voo com teste real `ioctl(UDMABUF_CREATE)`, `vm.max_map_count` e PipeWire | `scripts/preflight.sh` | ✅ Pronto |
| 1.6 | Auditoria e atualização segura da EFI (`Graft`/`ReimsGraphics`/`RgfxGate` + NVRAM 14 bytes) | `scripts/efi-manager.sh` | ✅ Pronto |
| 1.7 | Golden Backup & Rollback atômico (EFI + OVMF + `vm.toml` + symlink QEMU) | `scripts/backup.sh`, `scripts/restore.sh` | ✅ Pronto |
| 1.8 | Reset instantâneo de overlay com caminho absoluto e trava de VM ativa | `scripts/reset-overlay.sh` | ✅ Pronto |

---

## ✅ Fase 2 — Monitoramento, Cockpit e Qualidade de Vida (IMPLEMENTADO)

| # | Funcionalidade | Arquivo | Status |
|---|---|---|---|
| 2.1 | Monitor em tempo real: GPU, VRAM, temperatura, TDP (compatível com locale `pt_BR`) | `scripts/monitor.sh` | ✅ Pronto |
| 2.2 | Painel Web Cockpit com detecção em `/root` e shutdown gracioso via `reims-ctl stop` | `cockpit-plugin/app.js` | ✅ Pronto |
| 2.3 | Logs rotativos por sessão com histórico de erros | `scripts/logger.sh`, `scripts/logs.sh` | ✅ Pronto |
| 2.4 | Área de transferência compartilhada e pasta compartilhada | `scripts/qol.sh` | ✅ Pronto |
| 2.5 | Gerenciamento SSH remoto e túnel para o macOS (porta 2222) | `scripts/ssh-manager.sh` | ✅ Pronto |
| 2.6 | Baixador automático da imagem oficial do macOS | `tools/fetch-macos.py` | ✅ Pronto |

---

## 🔧 Fase 3 — Perfis Dual-GPU & Otimização Avançada (PRÓXIMOS PASSOS)

### 3.1 Perfil Dual-GPU (`reims-vgpu` vs `vfio-nullmoth`)
> **Contexto:** O `reims.env` já expõe `GPU_MODE="reims-vgpu"`. Caso shaders avançados (ex.: Memojis 3D no Tahoe) exijam aceleração nativa direta, o host já possui RTX 3070 isolada em grupo IOMMU próprio (23/24) e Resizable BAR de 8 GB ativo.

- Implementar alternância automatizada entre `reims-vgpu` (janela no host Linux) e `vfio-nullmoth` (`nvidia-macos-driver` + saída HDMI/DisplayPort direta da RTX 3070), com retorno garantido via `./reims rollback`.

### 3.2 CPU Pinning — Isolamento de Núcleos do Ryzen 5600X
> **Impacto:** Elimina micro-travamentos em áudio, animações e renderização Metal.

1. Configurar `isolcpus` / `nohz_full` no GRUB para dedicar núcleos à VM.
2. Integrar `taskset` / `CPU_PINNING=true` no launcher.

### 3.3 Virtual Bridge (TAP Networking) — macOS na Rede Local
> **Impacto:** O macOS ganha IP próprio no roteador para AirDrop/Handoff/Bonjour.

### 3.4 Looking Glass (Apenas para modo VFIO Passthrough puro)
> **Nota:** Não aplicável ao modo `reims-vgpu` (que já renderiza diretamente via Vulkan + `udmabuf` no host), sendo útil apenas caso adote `vfio-nullmoth` sem cabo dedicado no monitor.

---

## 🚀 Fase 4 — Funcionalidades Futuras

| # | Funcionalidade | Descrição | Dificuldade |
|---|---|---|---|
| 4.1 | **Auto-restart em Crash** | Daemon/systemd que reinicia a VM se o QEMU cair | Média |
| 4.2 | **iCloud / AppleID** | Configuração de ROM/MAC/SMBIOS persistentes para serviços Apple | Média |
| 4.3 | **Multi-VM** | Suporte a múltiplos perfis de macOS (Sonoma, Sequoia, Tahoe) | Alta |
| 4.4 | **USB Controller Passthrough** | Passar controladora USB PCIe inteira para interfaces de áudio pro | Alta |
