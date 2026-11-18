// ==============================================================================
// REIMS Cockpit Plugin — app.js
// Controla o macOS Tahoe diretamente pelo browser via cockpit.spawn()
// ==============================================================================

// Caminho absoluto do projeto (ajuste se necessário após instalar no Debian)
const REIMS_DIR = '/home/' + cockpit.user || '/root';
let REIMS_PATH = '';

// Detecta o caminho do projeto automaticamente
cockpit.spawn(['bash', '-c', 'find /home -name "reims" -type f 2>/dev/null | head -1 || echo ""'])
    .done(path => {
        REIMS_PATH = path.trim().replace('/reims', '');
        log('ok', `Projeto REIMS encontrado em: ${REIMS_PATH}`);
        carregarConfig();
        verificarStatus();
    })
    .fail(() => {
        log('aviso', 'Projeto REIMS não localizado. Verifique o caminho em reims-mac/.');
    });

// ── Log Visual ──────────────────────────────────────────────────────────────
function log(tipo, msg) {
    const box = document.getElementById('log-box');
    const linha = document.createElement('div');
    const ts = new Date().toLocaleTimeString('pt-BR');
    linha.className = `log-line ${tipo}`;
    linha.textContent = `[${ts}] ${msg}`;
    box.appendChild(linha);
    box.scrollTop = box.scrollHeight;
}

function limparLog() {
    const box = document.getElementById('log-box');
    box.innerHTML = '<div class="log-line info">[ Log limpo ]</div>';
}

// ── Status da VM ─────────────────────────────────────────────────────────────
function verificarStatus() {
    const pill = document.getElementById('vm-status-pill');
    cockpit.spawn(['bash', '-c', 'pgrep -x qemu-system-x86_64 > /dev/null 2>&1 && echo running || echo stopped'])
        .done(result => {
            const rodando = result.trim() === 'running';
            pill.textContent = rodando ? '● Rodando' : '○ Parada';
            pill.className = `status-pill ${rodando ? 'running' : 'stopped'}`;
            document.getElementById('btn-start').disabled = rodando;
            document.getElementById('btn-kill').disabled = !rodando;
        });
}

// ── Executar Comandos do REIMS ────────────────────────────────────────────────
function reimsCmd(cmd, args) {
    if (!REIMS_PATH) { log('erro', 'Caminho do projeto não encontrado.'); return; }

    const pill = document.getElementById('vm-status-pill');
    pill.textContent = 'Executando...';
    pill.className = 'status-pill loading';

    log('info', `Executando: ./reims ${cmd}`);

    const comando = args
        ? ['bash', '-c', `cd "${REIMS_PATH}" && ./reims ${cmd} ${args}`]
        : ['bash', '-c', `cd "${REIMS_PATH}" && ./reims ${cmd}`];

    cockpit.spawn(comando, { superuser: 'try' })
        .stream(data => {
            data.split('\n').filter(l => l.trim()).forEach(linha => {
                const tipo = linha.includes('ERRO') ? 'erro'
                    : linha.includes('OK') || linha.includes('✓') ? 'ok'
                    : linha.includes('AVISO') || linha.includes('!') ? 'aviso'
                    : 'info';
                log(tipo, linha);
            });
        })
        .done(() => {
            log('ok', `Comando '${cmd}' finalizado.`);
            verificarStatus();
        })
        .fail((err) => {
            log('erro', `Falha em '${cmd}': ${err.message || err}`);
            verificarStatus();
        });
}

// ── Matar a VM ────────────────────────────────────────────────────────────────
function killVM() {
    if (!confirm('Parar o macOS Tahoe agora? Certifique-se de salvar seus arquivos antes.')) return;
    log('aviso', 'Encerrando processo da VM...');
    cockpit.spawn(['bash', '-c', 'pkill -f qemu-system-x86_64 || true'], { superuser: 'try' })
        .done(() => { log('ok', 'VM encerrada.'); verificarStatus(); })
        .fail(() => { log('erro', 'Não foi possível encerrar a VM.'); });
}

// ── Monitor de Hardware em Tempo Real ─────────────────────────────────────────
function atualizarMetricas() {
    // GPU e temperatura via nvidia-smi
    cockpit.spawn(['bash', '-c',
        'nvidia-smi --query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || echo "0,0,8192,0,0"'
    ]).done(data => {
        const [temp, vramUsado, vramTotal, gpuUso, tdp] = data.trim().split(',').map(v => parseFloat(v.trim()) || 0);

        document.getElementById('m-temp').textContent = `${temp}°C`;
        document.getElementById('m-gpu').textContent = `${gpuUso}%`;
        document.getElementById('m-vram').textContent = `${vramUsado} MB`;
        document.getElementById('m-vram-total').textContent = `de ${vramTotal} MB`;
        document.getElementById('m-tdp').textContent = `${tdp} W`;

        setBar('bar-temp', temp, 100);
        setBar('bar-gpu', gpuUso, 100);
        setBar('bar-vram', vramUsado, vramTotal);
    });

    // RAM e CPU do host
    cockpit.spawn(['bash', '-c',
        "free -m | awk '/^Mem:/{print $3, $2}'; top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | sed 's/%us,//'"
    ]).done(data => {
        const linhas = data.trim().split('\n');
        if (linhas.length >= 2) {
            const [ramUsado, ramTotal] = linhas[0].split(' ').map(Number);
            const cpuUso = parseFloat(linhas[1]) || 0;

            document.getElementById('m-ram').textContent = `${(ramUsado/1024).toFixed(1)} GB`;
            document.getElementById('m-ram-total').textContent = `de ${(ramTotal/1024).toFixed(0)} GB`;
            document.getElementById('m-cpu').textContent = `${cpuUso.toFixed(0)}%`;

            setBar('bar-ram', ramUsado, ramTotal);
            setBar('bar-cpu', cpuUso, 100);
        }
    });
}

function setBar(id, valor, maximo) {
    const pct = Math.min(100, Math.round((valor / maximo) * 100));
    const bar = document.getElementById(id);
    if (!bar) return;
    bar.style.width = `${pct}%`;
    bar.className = `bar-fill ${pct < 60 ? 'bar-green' : pct < 85 ? 'bar-yellow' : 'bar-red'}`;
}

// ── Carregar e Salvar Configurações ──────────────────────────────────────────
function carregarConfig() {
    if (!REIMS_PATH) return;
    cockpit.file(`${REIMS_PATH}/reims.env`).read()
        .done(conteudo => {
            const cfg = {};
            conteudo.split('\n').forEach(linha => {
                const m = linha.match(/^(\w+)="?([^"#]+)"?\s*$/);
                if (m) cfg[m[1]] = m[2].trim();
            });

            if (cfg.DRIVER_GPU) document.getElementById('cfg-driver').value = cfg.DRIVER_GPU;
            if (cfg.RAM)        document.getElementById('cfg-ram').value = cfg.RAM;
            if (cfg.DISPLAY_MODE) document.getElementById('cfg-display').value = cfg.DISPLAY_MODE;
            if (cfg.VRAM_MB)    document.getElementById('cfg-vram').value = cfg.VRAM_MB;

            log('ok', 'Configurações carregadas do reims.env');
        });
}

function salvarConfig(chave, valor) {
    if (!REIMS_PATH) return;
    cockpit.spawn(['bash', '-c',
        `sed -i 's|^${chave}=.*|${chave}="${valor}"|' "${REIMS_PATH}/reims.env"`,
    ], { superuser: 'try' })
        .done(() => log('ok', `${chave} atualizado para: ${valor}`))
        .fail(err => log('erro', `Falha ao salvar ${chave}: ${err}`));
}

// ── Inicialização ─────────────────────────────────────────────────────────────
setInterval(() => {
    atualizarMetricas();
    verificarStatus();
}, 3000);

atualizarMetricas();
