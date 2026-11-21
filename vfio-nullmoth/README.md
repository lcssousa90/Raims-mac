# Configuração da VM macOS (RTX 3070 VFIO Passthrough + NullMoth 3.0)

Este diretório reúne todas as configurações e scripts do host Linux (Debian/PVE 6.11) e do guest macOS para rodar a VM `mac` com GPU passthrough nativo da **NVIDIA GeForce RTX 3070** via **NullMoth 3.0**, Wi-Fi Intel AX200 (`05:00.0`), Bluetooth Intel (`8087:0029`) e controladora USB (`09:00.3`).

## O que foi incluído
- `scripts/iniciar-nullmoth-vfio.sh` — Inicialização completa da VM VFIO (HugePages 12 GB, 8 vCPUs pinned 1:1 nos núcleos `1,7,2,8,3,9,4,10`, IRQs isolados em `0,5,6,11`, `nvfbheads=4`).
- `scripts/reverte-tudo.sh` — Script de reversão limpa de VFIO para Reims vGPU (incluindo `remove_id` no `vfio-pci`).
- `scripts/bt-control.sh` — Controle de attach/detach do Bluetooth Intel `8087:0029` via QMP.
- `scripts/guest/` — Scripts de otimização do NullMoth 3.0 dentro do macOS (`nvrm610.conf`, GPU Boost Daemon, Vulkan NVK, DLSS).
- `host-config/` — `modprobe.d` (`vfio.conf`, `kvm.conf`, `blacklist-bluetooth.conf`), `modules-load.d`, `systemd`, `grub/cmdline.txt` e `root/bash_profile`.
- `vm/` — `vm.toml` e `opencore-config.sanitized.plist` (serial/MLB/UUID/ROM removidos).

## Correções aplicadas (2 monitores + tela preta no boot)
1. **Deadlock / Kernel Oops no `btusb` (`mgmt_pending_remove`):** `iniciar-nullmoth-vfio.sh` agora aplica `systemctl mask --runtime bluetooth.service` e `systemctl stop bluetooth.service` antes de `modprobe btusb` (e usa `timeout 5` no unbind/remoção), impedindo que o `udev` suba o `bluetoothd` durante o pré-carregamento do firmware e trave o script antes do QEMU iniciar.
2. **RTX 3070 vinculada ao `vfio-pci` desde o boot (`host-config/modprobe.d/vfio.conf`):** `10de:2484` e `10de:228b` são entregues diretamente ao `vfio-pci` no initramfs (`softdep nvidia/nvidia_drm/nvidia_modeset/nouveau pre: vfio-pci`), evitando que o `nvidia-modeset` do host inicialize os 2 monitores (DP + HDMI) antes do OVMF/macOS assumir a placa.

## O que NÃO é versionado neste repositório
- Discos virtuais (`disk.qcow2`, `installer.img`, imagens `opencore*.qcow2`, `OVMF_VARS.fd`).
- Binários do NullMoth 3.0 (licença não comercial — baixar separadamente).
- Segredos, chaves SSH/TLS, `.env` e históricos de shell.
