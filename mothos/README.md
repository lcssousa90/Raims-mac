# MothOS — Painel de Monitoramento e Controle (Host Linux + VM macOS VFIO)

Aplicação web (PWA) separada dentro do projeto `Raims-mac` para monitorar em tempo real CPU, memória, GPU RTX 3070 (incluindo telemetria ao vivo do NullMoth via `/api/gpu/guest_report`), USB passthrough, serviços systemd, logs, arquivos, terminal WebSocket e controle da VM macOS VFIO.

## Estrutura
- `backend/` — Servidor HTTP/HTTPS + WebSocket em Python 3 (stdlib) com testes em `backend/tests/test_mothos.py`.
- `frontend/` — Interface web PWA (`index.html`, `js/`, `css/`, `icons/`, `sw.js`).
- `deploy/` — `mothos.service`, `install-host.sh` e `mothos.env.example`.

## Instalação no Host
1. Copie `mothos/` para `/opt/mothos`.
2. Crie `/etc/mothos.env` baseado em `deploy/mothos.env.example` definindo seu `MOTHOS_PIN` e `MOTHOS_SECRET`.
3. Execute `sudo /opt/mothos/deploy/install-host.sh`.
