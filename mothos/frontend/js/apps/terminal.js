/**
 * App 6: Logs & Terminal de Emergência
 * Tab 1: Logs ao Vivo (qemu, dmesg, watchdog, mothos) com busca e destaque de erros/avisos
 * Tab 2: Terminal interativo via WS /ws/terminal com atalhos rápidos para celular
 */

import { apiFetch, buildWsUrl } from '../api.js';
import { Icons, showToast } from '../ui.js';
import { esc, stripAnsi, classifyLogLine, debounce } from '../utils.js';

const MAX_TERM_CHARS = 60000;

export function mountTerminalApp(container) {
  let activeTab = 'logs';
  let logSource = 'qemu';
  let logLines = 150;
  let logFilter = '';
  let logAuto = true;
  let logTimer = null;

  let termWs = null;
  let termBuffer = '';
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack terminal-app">
      <!-- Segmented Tab Bar -->
      <div class="segmented-control glass-panel">
        <button type="button" class="seg-btn active" data-tab="logs">Logs ao Vivo</button>
        <button type="button" class="seg-btn" data-tab="terminal">Terminal de Emergência</button>
      </div>

      <!-- Tab 1: Live Logs -->
      <div id="tab-logs-panel" class="app-stack">
        <div class="glass-card logs-controls-card">
          <div class="source-pills" id="log-source-pills">
            <button type="button" class="source-pill active" data-source="qemu">QEMU</button>
            <button type="button" class="source-pill" data-source="dmesg">dmesg</button>
            <button type="button" class="source-pill" data-source="watchdog">Watchdog</button>
            <button type="button" class="source-pill" data-source="mothos">MothOS</button>
          </div>

          <div class="logs-toolbar">
            <input type="search" id="log-filter-input" class="glass-input glass-input-sm" placeholder="Filtrar texto nos logs...">
            <select id="log-lines-select" class="glass-select">
              <option value="100">100 linhas</option>
              <option value="150" selected>150 linhas</option>
              <option value="300">300 linhas</option>
              <option value="500">500 linhas</option>
            </select>
            <label class="toggle-chip">
              <input type="checkbox" id="log-auto-toggle" checked>
              <span>Auto (3s)</span>
            </label>
            <button type="button" class="btn btn-sm btn-ghost" id="log-refresh-btn">
              <span class="btn-icon">${Icons.refresh}</span>
            </button>
          </div>
        </div>

        <div class="glass-card logs-viewer-card">
          <div class="logs-meta-bar">
            <span id="log-meta-info" class="mono">Carregando logs...</span>
            <button type="button" class="btn btn-xs btn-ghost" id="log-bottom-btn">Ir ao final ↓</button>
          </div>
          <div class="log-lines-box mono" id="log-lines-box"></div>
        </div>
      </div>

      <!-- Tab 2: Interactive Emergency Terminal -->
      <div id="tab-term-panel" class="app-stack hidden">
        <div class="glass-card term-card">
          <div class="term-header">
            <div class="term-status-wrap">
              <span class="pill pill-sm pill-muted" id="term-ws-pill">Desconectado</span>
              <span class="term-hint mono">/bin/bash PTY</span>
            </div>
            <div class="term-head-actions">
              <button type="button" class="btn btn-xs btn-ghost" id="term-reconnect-btn">Reconectar</button>
            </div>
          </div>

          <!-- Quick Shortcut Chips for Phone Typing -->
          <div class="term-chips" id="term-chips">
            <button type="button" class="term-chip" data-cmd="uptime">uptime</button>
            <button type="button" class="term-chip" data-cmd="lsusb">lsusb</button>
            <button type="button" class="term-chip" data-cmd="sensors">sensors</button>
            <button type="button" class="term-chip" data-cmd="/root/bt-control.sh status">bt-control status</button>
            <button type="button" class="term-chip" data-cmd="lspci -nnk -s 07:00">RTX 3070</button>
            <button type="button" class="term-chip" data-cmd="free -h">free -h</button>
            <button type="button" class="term-chip" data-cmd="df -h">df -h</button>
            <button type="button" class="term-chip chip-warn" data-cmd="CTRL_C">Ctrl+C</button>
            <button type="button" class="term-chip chip-muted" data-cmd="CLEAR">Limpar</button>
            <button type="button" class="term-chip chip-muted" data-cmd="TAB">Tab</button>
          </div>

          <!-- Terminal Output Viewport -->
          <pre class="term-viewport mono" id="term-viewport" tabindex="0" aria-label="Saída do terminal"></pre>

          <!-- Command Input Bar (ideal for mobile keyboards) -->
          <form class="term-input-bar" id="term-input-form">
            <span class="term-prompt-symbol mono">$</span>
            <input
              type="text"
              id="term-input"
              class="term-input mono"
              placeholder="Digite um comando e pressione Enter..."
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
            >
            <button type="submit" class="btn btn-sm btn-primary" title="Enviar comando">
              <span class="btn-icon">${Icons.send}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  `;

  const refs = {
    logsPanel: container.querySelector('#tab-logs-panel'),
    termPanel: container.querySelector('#tab-term-panel'),
    sourcePills: container.querySelector('#log-source-pills'),
    filterInput: container.querySelector('#log-filter-input'),
    linesSelect: container.querySelector('#log-lines-select'),
    autoToggle: container.querySelector('#log-auto-toggle'),
    refreshBtn: container.querySelector('#log-refresh-btn'),
    bottomBtn: container.querySelector('#log-bottom-btn'),
    logMeta: container.querySelector('#log-meta-info'),
    logBox: container.querySelector('#log-lines-box'),
    // Terminal
    termPill: container.querySelector('#term-ws-pill'),
    termReconnect: container.querySelector('#term-reconnect-btn'),
    termChips: container.querySelector('#term-chips'),
    termViewport: container.querySelector('#term-viewport'),
    termForm: container.querySelector('#term-input-form'),
    termInput: container.querySelector('#term-input'),
  };

  // --- LOGS LOGIC ---

  async function fetchLogs(silent = false) {
    if (destroyed || activeTab !== 'logs') return;
    try {
      const qs = new URLSearchParams({
        source: logSource,
        lines: String(logLines),
        filter: logFilter,
      });
      const res = await apiFetch(`/api/logs?${qs.toString()}`);
      if (destroyed) return;

      const lines = Array.isArray(res.lines) ? res.lines : [];
      const wasAtBottom =
        refs.logBox.scrollHeight - refs.logBox.scrollTop - refs.logBox.clientHeight < 60;

      refs.logMeta.textContent = `Fonte: ${res.source || logSource} • ${lines.length} linha(s)`;

      if (lines.length === 0) {
        refs.logBox.innerHTML = `<div class="empty-note">Nenhuma linha encontrada para este filtro.</div>`;
      } else {
        refs.logBox.innerHTML = lines
          .map((line) => {
            const cls = classifyLogLine(line);
            return `<div class="log-line ${cls}">${esc(line)}</div>`;
          })
          .join('');
      }

      if (wasAtBottom || !silent) {
        refs.logBox.scrollTop = refs.logBox.scrollHeight;
      }
    } catch (err) {
      if (!silent) showToast(`Erro ao carregar logs: ${err.message}`, 'error');
    }
  }

  function startLogAutoRefresh() {
    clearInterval(logTimer);
    if (logAuto && activeTab === 'logs' && !destroyed) {
      logTimer = setInterval(() => fetchLogs(true), 3000);
    }
  }

  // --- TERMINAL LOGIC ---

  function appendTermText(chunk) {
    const clean = stripAnsi(chunk);
    if (!clean) return;
    termBuffer += clean;
    if (termBuffer.length > MAX_TERM_CHARS) {
      termBuffer = termBuffer.slice(termBuffer.length - MAX_TERM_CHARS);
    }
    refs.termViewport.textContent = termBuffer;
    refs.termViewport.scrollTop = refs.termViewport.scrollHeight;
  }

  function setTermStatus(label, pillClass) {
    refs.termPill.className = `pill pill-sm ${pillClass}`;
    refs.termPill.textContent = label;
  }

  function sendTermResize() {
    if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
    const width = refs.termViewport.clientWidth || 640;
    const height = refs.termViewport.clientHeight || 360;
    const cols = Math.max(40, Math.min(200, Math.floor((width - 24) / 8.2)));
    const rows = Math.max(12, Math.min(60, Math.floor((height - 20) / 18)));
    termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  async function runQuickFallback(command) {
    appendTermText(`\n$ ${command}\n`);
    try {
      const res = await apiFetch('/api/terminal/exec', {
        method: 'POST',
        body: { command },
      });
      if (res.output) appendTermText(res.output + (res.output.endsWith('\n') ? '' : '\n'));
    } catch (err) {
      appendTermText(`[erro: ${err.message}]\n`);
    }
  }

  function sendTermInput(data) {
    if (!termWs || termWs.readyState !== WebSocket.OPEN) {
      const trimmed = String(data || '').replace(/\n+$/, '').trim();
      if (trimmed && trimmed !== '\x03' && trimmed !== '\t') {
        runQuickFallback(trimmed);
      } else {
        showToast('Terminal PTY desconectado. Clique em Reconectar.', 'warn');
      }
      return;
    }
    termWs.send(JSON.stringify({ type: 'input', data }));
  }

  function disconnectTerminal() {
    if (termWs) {
      const ws = termWs;
      termWs = null;
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
  }

  function connectTerminal() {
    if (destroyed) return;
    disconnectTerminal();
    setTermStatus('Conectando...', 'pill-amber');

    let ws;
    try {
      ws = new WebSocket(buildWsUrl('/ws/terminal'));
    } catch {
      setTermStatus('Erro', 'pill-rose');
      return;
    }
    termWs = ws;

    ws.addEventListener('open', () => {
      if (termWs !== ws) return;
      setTermStatus('Conectado', 'pill-green');
      sendTermResize();
    });

    ws.addEventListener('message', (event) => {
      if (termWs !== ws) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && typeof msg.data === 'string') {
          appendTermText(msg.data);
        } else if (msg.type === 'exit') {
          appendTermText(`\n[Sessão encerrada — código ${msg.code ?? 0}]\n`);
          setTermStatus('Encerrado', 'pill-muted');
        }
      } catch {
        // Fallback if plain text
        if (typeof event.data === 'string') appendTermText(event.data);
      }
    });

    ws.addEventListener('close', () => {
      if (termWs !== ws) return;
      termWs = null;
      if (!destroyed) setTermStatus('Desconectado', 'pill-rose');
    });

    ws.addEventListener('error', () => {
      if (termWs !== ws) return;
      setTermStatus('Erro WS', 'pill-rose');
    });
  }

  // --- TAB SWITCHING ---

  function switchTab(tab) {
    activeTab = tab;
    container.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    refs.logsPanel.classList.toggle('hidden', tab !== 'logs');
    refs.termPanel.classList.toggle('hidden', tab !== 'terminal');

    if (tab === 'logs') {
      fetchLogs();
      startLogAutoRefresh();
    } else {
      clearInterval(logTimer);
      if (!termWs || termWs.readyState !== WebSocket.OPEN) {
        connectTerminal();
      }
      setTimeout(() => {
        sendTermResize();
        refs.termInput.focus();
      }, 60);
    }
  }

  // --- EVENTS ---

  container.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  refs.sourcePills.addEventListener('click', (e) => {
    const pill = e.target.closest('button[data-source]');
    if (!pill) return;
    logSource = pill.dataset.source;
    refs.sourcePills.querySelectorAll('.source-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.source === logSource);
    });
    fetchLogs();
  });

  const debouncedFilter = debounce(() => {
    logFilter = refs.filterInput.value.trim();
    fetchLogs();
  }, 260);
  refs.filterInput.addEventListener('input', debouncedFilter);

  refs.linesSelect.addEventListener('change', () => {
    logLines = Number(refs.linesSelect.value) || 150;
    fetchLogs();
  });

  refs.autoToggle.addEventListener('change', () => {
    logAuto = refs.autoToggle.checked;
    startLogAutoRefresh();
  });

  refs.refreshBtn.addEventListener('click', () => fetchLogs());
  refs.bottomBtn.addEventListener('click', () => {
    refs.logBox.scrollTop = refs.logBox.scrollHeight;
  });

  refs.termReconnect.addEventListener('click', connectTerminal);

  refs.termChips.addEventListener('click', (e) => {
    const chip = e.target.closest('button[data-cmd]');
    if (!chip) return;
    const cmd = chip.dataset.cmd;
    if (cmd === 'CTRL_C') {
      sendTermInput('\x03');
    } else if (cmd === 'CLEAR') {
      termBuffer = '';
      refs.termViewport.textContent = '';
      if (termWs && termWs.readyState === WebSocket.OPEN) {
        sendTermInput('clear\n');
      }
    } else if (cmd === 'TAB') {
      sendTermInput('\t');
    } else {
      sendTermInput(`${cmd}\n`);
    }
    refs.termInput.focus();
  });

  refs.termForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = refs.termInput.value;
    sendTermInput(`${cmd}\n`);
    refs.termInput.value = '';
  });

  // Allow direct Ctrl+C from input field too
  refs.termInput.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && !refs.termInput.value) {
      e.preventDefault();
      sendTermInput('\x03');
    }
  });

  const onResize = debounce(() => {
    if (activeTab === 'terminal') sendTermResize();
  }, 200);
  window.addEventListener('resize', onResize);

  // Start on Logs tab
  fetchLogs();
  startLogAutoRefresh();

  return () => {
    destroyed = true;
    clearInterval(logTimer);
    window.removeEventListener('resize', onResize);
    disconnectTerminal();
  };
}
