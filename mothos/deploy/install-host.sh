#!/usr/bin/env bash
set -euo pipefail

# MothOS installer for Debian 13 host (192.168.18.10:8090)
# Usage: sudo bash deploy/install-host.sh

if [[ "${EUID}" -ne 0 ]]; then
    echo "Erro: execute como root (ex: sudo bash $0)" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="/opt/mothos"
ENV_FILE="/etc/mothos.env"
SERVICE_DST="/etc/systemd/system/mothos.service"
DATA_DIR="/var/lib/mothos"

echo "==> Instalando MothOS em ${INSTALL_DIR}..."
if [[ ! -f "${SRC_DIR}/backend/run.py" ]]; then
    echo "Erro: backend/run.py não encontrado em ${SRC_DIR}" >&2
    exit 1
fi

mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}"

# Copy backend, frontend, deploy (avoid copying local dev .data or __pycache__)
rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend" "${INSTALL_DIR}/deploy"
cp -a "${SRC_DIR}/backend" "${INSTALL_DIR}/backend"
if [[ -d "${SRC_DIR}/frontend" ]]; then
    cp -a "${SRC_DIR}/frontend" "${INSTALL_DIR}/frontend"
fi
cp -a "${SRC_DIR}/deploy" "${INSTALL_DIR}/deploy"

rm -rf "${INSTALL_DIR}/backend/.data"
find "${INSTALL_DIR}/backend" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
chmod +x "${INSTALL_DIR}/backend/run.py"

if [[ ! -f "${ENV_FILE}" ]]; then
    echo "==> Criando ${ENV_FILE} padrão..."
    SECRET_HEX="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    cat > "${ENV_FILE}" <<EOF
# MothOS configuration
MOTHOS_HOST=0.0.0.0
MOTHOS_PORT=8090
MOTHOS_HTTP_PORT_ALT=80
MOTHOS_HTTPS_PORT=8443
MOTHOS_HTTPS_PORT_ALT=443
MOTHOS_PIN=0000
MOTHOS_SECRET=${SECRET_HEX}
MOTHOS_DATA_DIR=${DATA_DIR}
EOF
    chmod 600 "${ENV_FILE}"
else
    echo "==> Mantendo ${ENV_FILE} existente."
fi

echo "==> Instalando systemd unit em ${SERVICE_DST}..."
cp -f "${INSTALL_DIR}/deploy/mothos.service" "${SERVICE_DST}"
chmod 644 "${SERVICE_DST}"

systemctl daemon-reload
systemctl enable mothos.service
systemctl restart mothos.service

echo "==> Status do serviço:"
systemctl --no-pager -l status mothos.service || true

IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP_DISP="${IP_ADDR:-192.168.18.10}"
echo ""
echo "MothOS instalado com sucesso!"
echo "HTTP  : http://${IP_DISP}/  ou  http://${IP_DISP}:8090/"
echo "HTTPS : https://${IP_DISP}/  ou  https://${IP_DISP}:8443/"
echo "CA Cert Android: http://${IP_DISP}/mothos-ca.crt"
