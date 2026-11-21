#!/bin/bash
# Remove o bloco "my settings" do nvrm610.conf (volta ao padrao NullMoth) e pede reinicio
set -u
NV=/Library/GPUBundles/nvmtl/nvrm610.conf
[ -f "$NV" ] || { echo "nvrm610.conf nao encontrado"; exit 1; }
T=$(mktemp /tmp/nv.XXXXXX)
sudo awk '/^# --- my settings, kept on update ---$/{s=1;next} /^# --- end my settings ---$/{s=0;next} !s{print}' "$NV" > "$T"
sudo cp "$T" "$NV" && sudo chown root:wheel "$NV" && sudo chmod 644 "$NV"; rm -f "$T"
echo "--- $NV agora ---"; cat "$NV"
echo; echo "Pronto. Reinicie o Mac (menu Apple > Reiniciar) e teste o littleprince."
