# REIMS macOS Tahoe — Roadmap de Implementação

> **Hardware Alvo:** AMD Ryzen 5 5600X | NVIDIA RTX 3070 | 16 GB RAM | SSD NVMe 2 TB  
> **Sistema Host:** Debian 13 Trixie (ou Ubuntu 24.04 LTS)  
> **Objetivo:** macOS Tahoe como sistema principal, Debian como backend invisível.

---

## ✅ Fase 1 — Base e Segurança (JÁ IMPLEMENTADO)

| # | Funcionalidade | Arquivo | Status |
|---|---|---|---|
| 1.1 | Instalador blindado sem sobrescrever `sources.list` | `tools/setup-host.sh` | ✅ Pronto |
| 1.2 | Ativação de KVM, `udmabuf` e regras `udev` | `tools/setup-host.sh` | ✅ Pronto |
| 1.3 | Cópia automática do OVMF para `efi/` | `tools/setup-host.sh` | ✅ Pronto |
| 1.4 | Arquitetura de disco imutável (Backing File + overlay) | `scripts/run-tahoe.sh` | ✅ Pronto |
| 1.5 | Pré-voo com 9 verificações críticas antes de iniciar | `scripts/preflight.sh` | ✅ Pronto |
| 1.6 | Sistema de backup comprimido com retenção automática | `scripts/backup.sh` | ✅ Pronto |
| 1.7 | Restauração de backup com proteção dupla | `scripts/restore.sh` | ✅ Pronto |
| 1.8 | Reset instantâneo de overlay em 2 segundos | `scripts/reset-overlay.sh` | ✅ Pronto |

---

## ✅ Fase 2 — Monitoramento e Qualidade de Vida (JÁ IMPLEMENTADO)

| # | Funcionalidade | Arquivo | Status |
|---|---|---|---|
| 2.1 | Monitor em tempo real: GPU, VRAM, temperatura, TDP | `scripts/monitor.sh` | ✅ Pronto |
| 2.2 | Alertas de temperatura crítica (85°C) e VRAM cheia | `scripts/monitor.sh` | ✅ Pronto |
| 2.3 | Logs rotativos por sessão com histórico de erros | `scripts/logger.sh` | ✅ Pronto |
| 2.4 | Visualizador de logs ao vivo com código de cores | `scripts/logs.sh` | ✅ Pronto |
| 2.5 | Área de transferência compartilhada (macOS ↔ Debian) | `scripts/qol.sh` | ✅ Pronto |
| 2.6 | Pasta compartilhada via VirtFS | `scripts/qol.sh` | ✅ Pronto |
| 2.7 | Atalho clicável no Desktop do Debian | `scripts/qol.sh` | ✅ Pronto |
| 2.8 | Snapshot rápido com nome personalizado | `scripts/qol.sh` | ✅ Pronto |

---

## ✅ Fase 3 — Interface e Gerenciamento Remoto (JÁ IMPLEMENTADO)

| # | Funcionalidade | Arquivo | Status |
|---|---|---|---|
| 3.1 | Arquivo de configuração central (`reims.env`) | `reims.env` | ✅ Pronto |
| 3.2 | Menu visual interativo completo (12 opções) | `reims` | ✅ Pronto |
| 3.3 | Wizard automático de primeira execução | `reims` | ✅ Pronto |
| 3.4 | Troca de driver de GPU pelo menu (sem editar arquivos) | `reims` | ✅ Pronto |
| 3.5 | Configuração de acesso SSH ao host Debian | `scripts/ssh-manager.sh` | ✅ Pronto |
| 3.6 | Túnel SSH direto para o macOS (porta 2222) | `reims.env` + `run-tahoe.sh` | ✅ Pronto |
| 3.7 | Modo headless (Debian totalmente invisível) | `scripts/ssh-manager.sh` | ✅ Pronto |
| 3.8 | Baixador automático da imagem oficial do macOS | `tools/fetch-macos.py` | ✅ Pronto |

---

## 🔧 Fase 4 — Otimização de Performance (PRÓXIMOS PASSOS)

### 4.1 CPU Pinning — Isolamento de Núcleos do Ryzen 5600X
> **Impacto:** Elimina micro-travamentos em áudio, animações e renderização Metal.

**O que fazer:**
1. Editar `/etc/default/grub` no Debian para isolar 4 núcleos para a VM:
   ```bash
   GRUB_CMDLINE_LINUX="isolcpus=2,3,4,5,8,9,10,11 nohz_full=2,3,4,5,8,9,10,11 rcu_nocbs=2,3,4,5,8,9,10,11"
   sudo update-grub && reboot
   ```
2. Adicionar no `reims.env`: `CPU_PINNING=true`

---

### 4.2 Looking Glass — Exibição do macOS sem Overhead de SDL
> **Impacto:** Latência de exibição sub-milisegundo. Integração perfeita na área de trabalho.

**O que fazer:**
1. Instalar no Debian: `sudo apt install looking-glass-client`
2. Adicionar memória compartilhada à linha do QEMU:
   ```bash
   -device ivshmem-plain,memdev=ivshmem,bus=pcie.0 \
   -object memory-backend-file,id=ivshmem,share=on,mem-path=/dev/shm/looking-glass,size=128M
   ```
3. No Debian: `looking-glass-client` abre a janela com o frame do macOS.

---

### 4.3 Virtual Bridge (TAP Networking) — macOS na Rede Local
> **Impacto:** O macOS ganha IP próprio no roteador. AirDrop, Handoff e Bonjour funcionam nativamente.

**O que fazer:**
1. Criar interface bridge no Debian:
   ```bash
   sudo ip link add name br0 type bridge
   sudo ip link set enp3s0 master br0
   sudo ip link set br0 up
   ```
2. Alterar no `reims.env`: `REDE_MODO="bridge"` e `REDE_BRIDGE="br0"`

---

### 4.4 APFS TRIM — Manter o SSD NVMe Sempre Rápido
> **Impacto:** Evita queda de velocidade de escrita no NVMe com o tempo.

**O que fazer:**
1. Substituir `virtio-blk-pci` por `virtio-scsi` com suporte a TRIM:
   ```bash
   -device virtio-scsi-pci,id=scsi0 \
   -device scsi-hd,drive=MacHDD,bus=scsi0.0,discard=unmap
   ```

---

## 🚀 Fase 5 — Funcionalidades Avançadas (FUTURO)

| # | Funcionalidade | Descrição | Dificuldade |
|---|---|---|---|
| 5.1 | **GPU Passthrough Duplo** | Segunda placa para passthrough total (requer 2ª GPU) | Alta |
| 5.2 | **Auto-restart em Crash** | Daemon que reinicia a VM automaticamente se o QEMU morrer | Média |
| 5.3 | **Injeção de EDID** | Forçar resolução Ultrawide/4K no macOS via EDID customizado | Média |
| 5.4 | **iCloud / AppleID** | Configurar ROM MAC válida para login no iCloud | Média |
| 5.5 | **Secure Boot Virtual** | Implementar SBAT no OVMF para proteção adicional | Alta |
| 5.6 | **Dashboard Web** | Interface web local para gerenciar a VM pelo browser | Alta |
| 5.7 | **Multi-VM** | Suporte a múltiplos perfis de macOS (Sonoma, Sequoia, Tahoe) | Alta |
| 5.8 | **USB Controller Passthrough** | Passar controladora USB PCIe inteira para DACs e periféricos pro | Alta |

---

## 📋 Ordem de Implementação Recomendada

```
Fase 4 — Faça agora:
  [1] CPU Pinning       → Melhora geral de desempenho imediato
  [2] APFS TRIM         → Protege o SSD NVMe a longo prazo
  [3] TAP Networking    → Habilita AirDrop e integração com rede local

Próxima semana:
  [4] Looking Glass     → Experiência visual sem overhead de SDL

Futuro:
  [5] Auto-restart      → Alta disponibilidade headless
  [6] iCloud Setup      → Funcionalidade completa do ecossistema Apple
  [7] Dashboard Web     → Gerenciamento pelo browser de qualquer dispositivo
```

---

## 🗂️ Estrutura Atual do Projeto

```
reims-mac/
├── reims                        # Executável principal — ./reims
├── reims.env                    # Configurações centrais (driver, RAM, rede...)
├── ROADMAP.md                   # Este arquivo
├── README.md                    # Instruções de uso
├── efi/                         # Firmware UEFI e OpenCore
│   ├── OVMF_CODE.fd
│   ├── OVMF_VARS.fd
│   └── OpenCore_Tahoe.img
├── vms/                         # Discos da VM
│   ├── tahoe_base.qcow2         # Base imutável (bloqueada)
│   └── tahoe_live.qcow2         # Camada de uso (descartável)
├── backups/                     # Backups automáticos com retenção
├── logs/                        # Logs de sessão e erros
├── compartilhado/               # Pasta compartilhada macOS ↔ Debian
├── scripts/
│   ├── run-tahoe.sh             # Inicialização do QEMU
│   ├── preflight.sh             # Pré-voo (9 verificações)
│   ├── monitor.sh               # Monitor em tempo real
│   ├── backup.sh                # Backup inteligente
│   ├── restore.sh               # Restauração de backup
│   ├── reset-overlay.sh         # Reset instantâneo
│   ├── ssh-manager.sh           # Gerenciamento SSH
│   ├── logger.sh                # Sistema de logs
│   ├── logs.sh                  # Visualizador de logs
│   └── qol.sh                   # Utilitários de conforto
└── tools/
    ├── setup-host.sh            # Preparação do Debian
    └── fetch-macos.py           # Download oficial do macOS
```
