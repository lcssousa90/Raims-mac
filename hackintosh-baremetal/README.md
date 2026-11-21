# Hackintosh Bare-Metal (Nativo) — ASUS TUF GAMING B550M-PLUS (WI-FI) + Ryzen 5 5600X + RTX 3070 (NullMoth 3.0)

Esta pasta contém a **EFI OpenCore Bare-Metal completa** construída sob medida para o hardware físico real desta máquina, junto com o script `clonar-vm-para-disco-fisico.sh` para transferir o disco da VM (`disk.qcow2`) diretamente para uma partição ou disco físico sem precisar reinstalar o macOS nem o NullMoth 3.0.

## 1. O que está dentro de `hackintosh-baremetal/EFI/`
- **`EFI/OC/ACPI/`**:
  - `SSDT-EC-USBX-DESKTOP.aml` — Compilado especificamente para o caminho LPC `\_SB.PCI0.SBRG` da BIOS `2603` da ASUS TUF GAMING B550M-PLUS (WI-FI).
  - `SSDT-CPUR.aml` — Helper ACPI para chipset AMD B550.
- **`EFI/OC/Kexts/`**:
  - `Lilu.kext` (`1.7.2`)
  - `VirtualSMC.kext` (`1.3.8`) — Emulador SMC obrigatório no Bare-Metal.
  - `AMFIPass.kext` (`1.4.1`) — Bypass AMFI exigido pelo driver Metal `NVMTLDriver.bundle` do NullMoth 3.0.
  - `AppleMCEReporterDisabler.kext` (`12.0`) — Desabilita `AppleMCEReporter` em CPUs AMD Ryzen.
  - `NVMeFix.kext` (`1.1.3`) — Otimização para o SSD Netac NVMe 2TB PCIe 4.0 (`1f40:5236`).
  - `LucyRTL8125Ethernet.kext` (`1.2.4`) — Driver para a rede cabeada Realtek RTL8125 2.5GbE (`06:00.0`, `10ec:8125`).
  - `AppleALC.kext` (`1.9.8`, `MaxKernel=24.99.99`) — Áudio Realtek ALCS1200A (`alcid=1`) no macOS 15 Sequoia (no macOS 26 Tahoe o áudio onboard e HDMI é provido pelo `NMXAudio.kext` do NullMoth 3.0).
  - `IntelBluetoothFirmware.kext` (`2.4.0`) + `IntelBTPatcher.kext` (`2.4.0`) + `BlueToolFixup.kext` (`2.7.2`) — Bluetooth Intel AX200 (`8087:0029`).
  - `AirportItlwm.kext` (`2.3.0`) + `itlwm.kext` (`2.3.0`) — Wi-Fi 6 Intel AX200 (`05:00.0`, `8086:2723`).
  - `USBMap.kext` (`1.0`) — Mapa de portas USB físicas das duas controladoras da placa-mãe (`PTXH` `02:00.0` com 14 portas e `PRT5` do Bluetooth como `Internal / 255`; `XHC0` `09:00.3` com 8 portas traseiras).
- **`EFI/OC/config.plist`**:
  - **25 patches oficiais do `AMD_Vanilla`**, com as 4 entradas `algrey - Force cpuid_cores_per_package` ajustadas para **`06` núcleos** (`Ryzen 5 5600X`).
  - Quirks de Booter/Kernel configurados para ASUS B550 + Resizable BAR 8 GB (`ResizeAppleGpuBars = 0`).
  - `boot-args` completos para NullMoth 3.0 com suporte a até 4 monitores (`nvfb=1 nvaccel=1 nvfbheads=4 amfi_get_out_of_my_way=0x1 amfi=0x80 ipc_control_port_options=0`).
  - *(Nota: No GitHub os campos `SystemSerialNumber`, `MLB`, `SystemUUID` e `ROM` estão sanitizados como `REDACTED`. No host local, a cópia pronta com os seus seriais originais está em `/root/EFI_BAREMETAL_READY/EFI`).*

## 2. Como clonar o `disk.qcow2` atual para um disco/partição física
- **Para testar a EFI em um pendrive FAT32 primeiro (recomendado):**
  ```bash
  sudo /root/Raims-mac/hackintosh-baremetal/clonar-vm-para-disco-fisico.sh --instalar-efi /dev/sdX1
  ```
- **Para clonar apenas o container APFS (128 GiB) para uma partição física (ex.: `/dev/nvme0n1p6`):**
  ```bash
  sudo /root/Raims-mac/hackintosh-baremetal/clonar-vm-para-disco-fisico.sh --particao /dev/nvme0n1p6
  ```
- **Para clonar o disco inteiro da VM para um disco dedicado (ex.: `/dev/sda` — apaga o disco alvo):**
  ```bash
  sudo /root/Raims-mac/hackintosh-baremetal/clonar-vm-para-disco-fisico.sh --disco-inteiro /dev/sda
  ```
