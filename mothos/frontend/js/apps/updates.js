/**
 * App 5: Updates & Serviços (APT Check/Upgrade com console ao vivo + Systemd com proteção)
 */

import { apiFetch } from '../api.js';
import { Icons, showToast, confirmAction } from '../ui.js';
import { esc, stripAnsi } from '../utils.js';

export function mountUpdatesApp(container) {
  let aptData = null;
  let services = [];
  let pollTimer = null;
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack updates-app">
      <!-- APT Updates Section -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Atualizações do Sistema (APT)</h3>
            <p class="card-subtitle" id="apt-subtitle">Consultando pacotes disponíveis...</p>
          </div>
          <div class="header-actions">
            <span class="pill pill-sm pill-muted" id="apt-status-pill">—</span>
            <span class="pill pill-sm pill-cyan" id="apt-count-pill">0 pacotes</span>
          </div>
        </div>

        <div class="apt-actions-row">
          <button type="button" class="btn btn-primary" id="apt-check-btn">
            <span class="btn-icon">${Icons.refresh}</span> Verificar Atualizações
          </button>
          <button type="button" class="btn btn-emerald" id="apt-upgrade-btn">
            <span class="btn-icon">${Icons.download}</span> Atualizar Pacotes (1-Click)
          </button>
        </div>

        <div class="pkg-list" id="apt-pkg-list"></div>

        <div class="console-section hidden" id="apt-console-wrap">
          <div class="console-label">Saída ao vivo do APT</div>
          <pre class="console-box console-tall" id="apt-console"></pre>
        </div>
      </div>

      <!-- Systemd Services Section -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Serviços Systemd</h3>
            <p class="card-subtitle">Serviços críticos (SSH, NetworkManager, MothOS) possuem trava de proteção</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" id="svc-refresh-btn">
            <span class="btn-icon">${Icons.refresh}</span> Atualizar
          </button>
        </div>

        <div class="service-list" id="svc-list">
          <div class="empty-note">Carregando serviços systemd...</div>
        </div>

        <pre class="console-box hidden" id="svc-output-box"></pre>
      </div>
    </div>
  `;

  const refs = {
    aptSub: container.querySelector('#apt-subtitle'),
    aptStatusPill: container.querySelector('#apt-status-pill'),
    aptCountPill: container.querySelector('#apt-count-pill'),
    aptCheckBtn: container.querySelector('#apt-check-btn'),
    aptUpgradeBtn: container.querySelector('#apt-upgrade-btn'),
    aptPkgList: container.querySelector('#apt-pkg-list'),
    aptConsoleWrap: container.querySelector('#apt-console-wrap'),
    aptConsole: container.querySelector('#apt-console'),
    svcRefreshBtn: container.querySelector('#svc-refresh-btn'),
    svcList: container.querySelector('#svc-list'),
    svcOutput: container.querySelector('#svc-output-box'),
  };

  function schedulePoll(running) {
    clearTimeout(pollTimer);
    if (running && !destroyed) {
      pollTimer = setTimeout(loadAptStatus, 1500);
    }
  }

  function renderApt() {
    if (!aptData || destroyed) return;
    const running = Boolean(aptData.running);
    const count = Number(aptData.upgradable_count) || 0;
    const task = aptData.task || 'idle';

    const taskLabels = {
      idle: 'Pronto',
      check: 'Verificando...',
      upgrade: 'Atualizando...',
    };

    refs.aptStatusPill.className = `pill pill-sm ${running ? 'pill-amber' : 'pill-green'}`;
    refs.aptStatusPill.textContent = taskLabels[task] || task;

    refs.aptCountPill.className = `pill pill-sm ${count > 0 ? 'pill-cyan' : 'pill-muted'}`;
    refs.aptCountPill.textContent = count === 1 ? '1 pacote' : `${count} pacotes`;

    refs.aptSub.textContent = running
      ? `Tarefa "${task}" em andamento no host...`
      : count > 0
        ? `${count} atualização(ões) pendente(s) no Debian`
        : 'Sistema atualizado — nenhum pacote pendente';

    refs.aptCheckBtn.disabled = running;
    refs.aptUpgradeBtn.disabled = running;

    const pkgs = Array.isArray(aptData.packages) ? aptData.packages : [];
    if (pkgs.length === 0) {
      refs.aptPkgList.innerHTML = `<div class="empty-note">Nenhum pacote aguardando atualização.</div>`;
    } else {
      refs.aptPkgList.innerHTML = pkgs
        .map(
          (p) => `
          <div class="pkg-row">
            <span class="pkg-name mono">${esc(p.name)}</span>
            <span class="pkg-ver mono">
              <span class="ver-old">${esc(p.current || '—')}</span>
              <span class="ver-arrow">→</span>
              <span class="ver-new">${esc(p.candidate || '—')}</span>
            </span>
          </div>
        `
        )
        .join('');
    }

    if (aptData.output) {
      refs.aptConsoleWrap.classList.remove('hidden');
      refs.aptConsole.textContent = stripAnsi(aptData.output);
      refs.aptConsole.scrollTop = refs.aptConsole.scrollHeight;
    }

    schedulePoll(running);
  }

  function renderServices() {
    if (destroyed) return;
    if (services.length === 0) {
      refs.svcList.innerHTML = `<div class="empty-note">Nenhum serviço listado.</div>`;
      return;
    }

    refs.svcList.innerHTML = services
      .map((svc) => {
        const isActive = svc.active === 'active';
        const isEnabled = svc.enabled === 'enabled';
        const isProtected = Boolean(svc.protected);

        return `
          <div class="service-card ${isProtected ? 'service-protected' : ''}">
            <div class="service-head">
              <div class="service-title-wrap">
                <div class="service-label">
                  ${esc(svc.label || svc.name)}
                  ${
                    isProtected
                      ? `<span class="lock-badge" title="Serviço protegido: stop e disable bloqueados para evitar perda de acesso">${Icons.lock} Protegido</span>`
                      : ''
                  }
                </div>
                <div class="service-unit mono">${esc(svc.name)}</div>
              </div>
              <div class="service-badges">
                <span class="pill pill-xs ${isActive ? 'pill-green' : 'pill-muted'}">${esc(svc.active || 'inactive')}</span>
                <span class="pill pill-xs ${isEnabled ? 'pill-cyan' : 'pill-muted'}">${esc(svc.enabled || 'disabled')}</span>
              </div>
            </div>

            <div class="service-actions">
              <button type="button" class="btn btn-xs btn-emerald-soft" data-svc-name="${esc(svc.name)}" data-svc-action="start">Iniciar</button>
              <button type="button" class="btn btn-xs btn-cyan-soft" data-svc-name="${esc(svc.name)}" data-svc-action="restart">Reiniciar</button>
              <button type="button" class="btn btn-xs btn-rose-soft" data-svc-name="${esc(svc.name)}" data-svc-action="stop" ${isProtected ? 'disabled title="Bloqueado em serviço protegido"' : ''}>Parar</button>
              <button type="button" class="btn btn-xs btn-ghost" data-svc-name="${esc(svc.name)}" data-svc-action="enable">Habilitar</button>
              <button type="button" class="btn btn-xs btn-ghost" data-svc-name="${esc(svc.name)}" data-svc-action="disable" ${isProtected ? 'disabled title="Bloqueado em serviço protegido"' : ''}>Desabilitar</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function loadAptStatus() {
    try {
      aptData = await apiFetch('/api/updates/status');
      renderApt();
    } catch (err) {
      showToast(`Erro ao consultar APT: ${err.message}`, 'error');
    }
  }

  async function loadServices() {
    try {
      const res = await apiFetch('/api/services/list');
      services = Array.isArray(res.services) ? res.services : [];
      renderServices();
    } catch (err) {
      showToast(`Erro ao listar serviços: ${err.message}`, 'error');
    }
  }

  async function handleAptCheck() {
    try {
      await apiFetch('/api/updates/check', { method: 'POST' });
      showToast('Verificação de pacotes iniciada (apt-get update)...', 'info');
      await loadAptStatus();
    } catch (err) {
      showToast(`Erro ao verificar atualizações: ${err.message}`, 'error');
    }
  }

  async function handleAptUpgrade() {
    const ok = await confirmAction({
      title: 'Atualizar Pacotes Debian',
      message: 'Executar "apt-get -y upgrade" em segundo plano no host?',
      detail: 'Os pacotes listados serão atualizados automaticamente sem interação.',
      confirmLabel: 'Iniciar Atualização',
      danger: false,
    });
    if (!ok) return;

    try {
      await apiFetch('/api/updates/upgrade', {
        method: 'POST',
        body: { confirm: true },
      });
      showToast('Atualização APT iniciada!', 'success');
      await loadAptStatus();
    } catch (err) {
      showToast(`Erro ao iniciar upgrade: ${err.message}`, 'error');
    }
  }

  async function handleServiceAction(name, action) {
    const needsConfirm = action === 'stop' || action === 'restart' || action === 'disable';
    if (needsConfirm) {
      const labelMap = { stop: 'Parar', restart: 'Reiniciar', disable: 'Desabilitar' };
      const ok = await confirmAction({
        title: `${labelMap[action]} Serviço`,
        message: `Confirmar "${action}" no serviço ${name}?`,
        detail: `Executa systemctl ${action} ${name}`,
        confirmLabel: `${labelMap[action]} Agora`,
        danger: action !== 'restart',
      });
      if (!ok) return;
    }

    try {
      const res = await apiFetch('/api/services/action', {
        method: 'POST',
        body: { name, action, confirm: true },
      });
      if (res.output) {
        refs.svcOutput.textContent = res.output;
        refs.svcOutput.classList.remove('hidden');
      }
      showToast(res.ok ? `Serviço ${name}: ${action} executado.` : `Falha ao executar ${action} em ${name}.`, res.ok ? 'success' : 'error');
      await loadServices();
    } catch (err) {
      showToast(`Erro no serviço ${name}: ${err.message}`, 'error');
    }
  }

  refs.aptCheckBtn.addEventListener('click', handleAptCheck);
  refs.aptUpgradeBtn.addEventListener('click', handleAptUpgrade);
  refs.svcRefreshBtn.addEventListener('click', loadServices);

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-svc-action]');
    if (btn && !btn.disabled) {
      handleServiceAction(btn.dataset.svcName, btn.dataset.svcAction);
    }
  });

  loadAptStatus();
  loadServices();

  return () => {
    destroyed = true;
    clearTimeout(pollTimer);
  };
}
