Este diretório armazenará os arquivos EFI do OpenCore.

Arquivos necessários (a serem adicionados manualmente ou pelo setup):
- OVMF_CODE.fd           → Firmware UEFI (vem do pacote ovmf do Debian)
- OVMF_VARS.fd           → Variáveis NVRAM editáveis (cópia do ovmf, não usar o original)
- OpenCore_Tahoe.img     → Imagem da partição EFI do OpenCore configurada para o Tahoe

Kexts dentro do OpenCore_Tahoe.img (na pasta EFI/OC/Kexts/):
- AppleMCEReporterDisabler.kext  → Evita Kernel Panic no Ryzen 5600X
- VMHide.kext                    → Oculta flags de hipervisor do macOS
- ReimsVgpu.kext                 → Aceleração gráfica paravirtualizada (RTX 3070)
- Lilu.kext                      → Motor de patches de kernel
- VirtualSMC.kext                → Emula chip SMC da Apple

Para copiar o OVMF do Debian após o setup-host.sh:
  cp /usr/share/OVMF/OVMF_CODE_4M.fd efi/OVMF_CODE.fd
  cp /usr/share/OVMF/OVMF_VARS_4M.fd efi/OVMF_VARS.fd
