/**
 * App: VM & Energia (Organizado em Operação Normal, Dual-Boot & Host, e Zona de Emergência)
 */

import { apiFetch } from '../api.js';
import { refreshMonitorOnce } from '../store.js';
import { Icons, showToast, confirmAction } from '../ui.js';
import { esc } from '../utils.js';

export function mountVmApp(container) {
  let vmData = null;
  let busy = false;
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack vm-app">
      <!-- VM Status Card -->
      <div class="glass-card" id="vm-status-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Status da VM macOS</h3>
            <p class="card-subtitle" id="vm-subtitle">Consultando QEMU e socket QMP...</p>
          </div>
          <div class="header-actions">
            <span class="pill pill-muted" id="vm-running-pill">—</span>
            <button type="button" class="btn btn-sm btn-ghost" id="vm-refresh-btn">
              <span class="btn-icon">${Icons.refresh}</span> Atualizar
            </button>
          </div>
        </div>

        <div class="status-meta-grid" id="vm-meta-grid"></div>
      </div>

      <!-- Group 1: Operação Normal da VM -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Operação Normal da VM</h3>
            <p class="card-subtitle">Controles seguros de inicialização, desligamento limpo e watchdog</p>
          </div>
        </div>
        <div class="vm-group-grid">
          <button type="button" class="action-tile tile-emerald" data-vm-action="start">
            <span class="tile-icon">${Icons.play}</span>
            <span class="tile-label">Iniciar VM</span>
            <span class="tile-desc">iniciar-nullmoth-vfio.sh</span>
          </button>

          <button type="button" class="action-tile tile-amber" data-vm-action="shutdown">
            <span class="tile-icon">${Icons.power}</span>
            <span class="tile-label">Desligar Limpo</span>
            <span class="tile-desc">ACPI via QMP</span>
          </button>

          <button type="button" class="action-tile tile-cyan" data-vm-action="confirm_watchdog">
            <span class="tile-icon">${Icons.check}</span>
            <span class="tile-label">Confirmar Vídeo OK</span>
            <span class="tile-desc">Desarmar Watchdog</span>
          </button>

          <button type="button" class="action-tile tile-indigo" data-vm-action="toggle_vfio_default">
            <span class="tile-icon">${Icons.shield}</span>
            <span class="tile-label" id="vm-vfio-toggle-label">VFIO Permanente</span>
            <span class="tile-desc">.nullmoth_vfio_default</span>
          </button>
        </div>
      </div>

      <!-- OpenCore Image Selector -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Seletor de Imagem OpenCore</h3>
            <p class="card-subtitle">Escolha qual EFI .qcow2 usar na próxima inicialização da VM</p>
          </div>
        </div>
        <div class="opencore-list" id="vm-opencore-list">
          <div class="empty-note">Carregando imagens disponíveis...</div>
        </div>
      </div>

      <!-- Group 2: Host Power & 1-Click Windows -->
      <div class="glass-card power-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Dual-Boot &amp; Energia do PC Físico</h3>
            <p class="card-subtitle">Controle direto do computador Debian 13 / GRUB</p>
          </div>
        </div>

        <button type="button" class="windows-hero-btn" data-host-power="boot_windows">
          <span class="win-icon">${Icons.windows}</span>
          <span class="win-text">
            <strong>Reiniciar no Windows</strong>
            <small>Configura grub-reboot "windows-nvme" e reinicia o PC</small>
          </span>
          <span class="win-pill">1-Click</span>
        </button>

        <div class="host-power-row">
          <button type="button" class="btn btn-warn btn-lg" data-host-power="reboot">
            <span class="btn-icon">${Icons.reboot}</span> Reiniciar Host Linux
          </button>
          <button type="button" class="btn btn-danger btn-lg" data-host-power="shutdown">
            <span class="btn-icon">${Icons.power}</span> Desligar PC Físico
          </button>
        </div>
      </div>

      <!-- Group 3: Zona de Emergência & Recuperação -->
      <div class="glass-card danger-zone-card">
        <div class="card-header">
          <div>
            <h3 class="card-title text-rose">Zona de Emergência &amp; Recuperação</h3>
            <p class="card-subtitle">Use somente se a VM travar ou precisar reverter o VFIO</p>
          </div>
        </div>
        <div class="vm-danger-grid">
          <button type="button" class="action-tile tile-amber" data-vm-action="restart">
            <span class="tile-icon">${Icons.reboot}</span>
            <span class="tile-label">Reiniciar Sessão VFIO</span>
            <span class="tile-desc">Reinicia QEMU completo</span>
          </button>

          <button type="button" class="action-tile tile-rose" data-vm-action="force_stop">
            <span class="tile-icon">${Icons.stop}</span>
            <span class="tile-label">Forçar Parada QEMU</span>
            <span class="tile-desc">SIGTERM / SIGKILL</span>
          </button>

          <button type="button" class="action-tile tile-rose-outline" data-vm-action="revert">
            <span class="tile-icon">${Icons.warn}</span>
            <span class="tile-label">Reverter Tudo</span>
            <span class="tile-desc">/root/reverte-tudo.sh</span>
          </button>
        </div>
      </div>
    </div>
  `;

  const refs = {
    subtitle: container.querySelector('#vm-subtitle'),
    runningPill: container.querySelector('#vm-running-pill'),
    metaGrid: container.querySelector('#vm-meta-grid'),
    ocList: container.querySelector('#vm-opencore-list'),
    refreshBtn: container.querySelector('#vm-refresh-btn'),
    vfioLabel: container.querySelector('#vm-vfio-toggle-label'),
  };

  function setBusy(val) {
    busy = val;
    container.querySelectorAll('button[data-vm-action], button[data-host-power], button[data-opencore]').forEach((b) => {
      b.disabled = val;
    });
  }

  function renderVmStatus() {
    if (!vmData || destroyed) return;

    const running = Boolean(vmData.running);
    refs.runningPill.className = `pill ${running ? 'pill-green' : 'pill-muted'}`;
    refs.runningPill.textContent = running ? 'VM Online' : 'VM Parada';
    refs.subtitle.textContent = running
      ? `QEMU em execução (PID ${vmData.pid ?? '—'})`
      : 'Nenhuma instância QEMU ativa no momento';

    if (refs.vfioLabel) {
      refs.vfioLabel.textContent = vmData.vfio_default_flag ? 'VFIO Permanente: ON' : 'VFIO Permanente: OFF';
    }

    refs.metaGrid.innerHTML = `
      <div class="meta-chip">
        <span class="meta-k">PID QEMU</span>
        <strong class="meta-v mono">${esc(vmData.pid ?? '—')}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">Socket QMP</span>
        <strong class="meta-v ${vmData.qmp_connected ? 'text-green' : 'text-muted'}">${vmData.qmp_connected ? 'Conectado' : 'Desconectado'}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">VFIO Padrão</span>
        <strong class="meta-v">${vmData.vfio_default_flag ? 'Ativo' : 'Desativado'}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">Bluetooth</span>
        <strong class="meta-v ${vmData.bt_disabled_flag ? 'text-amber' : 'text-green'}">${vmData.bt_disabled_flag ? 'Desativado' : 'Habilitado'}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">Watchdog</span>
        <strong class="meta-v ${vmData.watchdog_active ? 'text-amber' : ''}">${vmData.watchdog_active ? 'Armado' : 'Inativo'}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">OpenCore Atual</span>
        <strong class="meta-v mono truncate" title="${esc(vmData.opencore || '')}">${esc(vmData.opencore || '—')}</strong>
      </div>
    `;

    const images = Array.isArray(vmData.available_opencores) ? vmData.available_opencores : [];
    if (images.length === 0) {
      refs.ocList.innerHTML = `<div class="empty-note">Nenhuma imagem OpenCore encontrada na pasta da VM.</div>`;
    } else {
      refs.ocList.innerHTML = images
        .map((img) => {
          const isActive = Boolean(img.active) || img.name === vmData.opencore;
          return `
            <button type="button" class="opencore-item ${isActive ? 'active' : ''}" data-opencore="${esc(img.name)}">
              <div class="oc-radio">${isActive ? Icons.check : ''}</div>
              <div class="oc-info">
                <div class="oc-name mono">${esc(img.name)}</div>
                <div class="oc-size">${esc(Number(img.size_mb || 0).toFixed(1))} MB</div>
              </div>
              <span class="pill pill-xs ${isActive ? 'pill-cyan' : 'pill-muted'}">${isActive ? 'Selecionada' : 'Usar'}</span>
            </button>
          `;
        })
        .join('');
    }
  }

  async function loadStatus() {
    try {
      vmData = await apiFetch('/api/vm/status');
      renderVmStatus();
    } catch (err) {
      showToast(`Erro ao carregar status da VM: ${err.message}`, 'error');
    }
  }

  const VM_ACTION_META = {
    start: {
      title: 'Iniciar VM macOS',
      message: 'Deseja iniciar a máquina virtual macOS com VFIO agora?',
      detail: 'Executa /root/iniciar-nullmoth-vfio.sh em segundo plano.',
      confirmLabel: 'Iniciar VM',
      danger: false,
      needsConfirm: true,
    },
    shutdown: {
      title: 'Desligar VM (ACPI Limpo)',
      message: 'Enviar sinal de desligamento limpo (system_powerdown) para o macOS?',
      detail: 'O macOS encerrará os aplicativos abertos e desligará com segurança.',
      confirmLabel: 'Enviar Desligamento',
      danger: false,
      needsConfirm: true,
    },
    confirm_watchdog: {
      needsConfirm: false,
    },
    toggle_vfio_default: {
      needsConfirm: false,
    },
    restart: {
      title: 'Reiniciar Sessão VFIO',
      message: 'Deseja reiniciar a VM macOS agora?',
      detail: 'Executa /root/iniciar-nullmoth-vfio.sh para reiniciar a sessão VFIO.',
      confirmLabel: 'Reiniciar VM',
      danger: true,
      needsConfirm: true,
    },
    force_stop: {
      title: 'Forçar Parada da VM',
      message: 'ATENÇÃO: isso encerra o processo QEMU imediatamente (SIGTERM/SIGKILL).',
      detail: 'Pode causar perda de dados não salvos dentro do macOS. Use apenas se a VM travar.',
      confirmLabel: 'Forçar Parada Agora',
      danger: true,
      needsConfirm: true,
    },
    revert: {
      title: 'Reverter VFIO (/root/reverte-tudo.sh)',
      message: 'Executar o script de reversão completa do VFIO no host?',
      detail: 'Encerra a VM e reverte as configurações de passthrough via /root/reverte-tudo.sh.',
      confirmLabel: 'Executar Reversão',
      danger: true,
      needsConfirm: true,
    },
  };

  const HOST_POWER_META = {
    boot_windows: {
      title: 'Reiniciar no Windows',
      message: 'O PC será reiniciado imediatamente para a partição Windows NVMe.',
      detail: 'Executa grub-reboot "windows-nvme" seguido de shutdown -r +0. O MothOS ficará indisponível até voltar ao Debian.',
      confirmLabel: 'Reiniciar no Windows Agora',
      danger: true,
    },
    reboot: {
      title: 'Reiniciar Host Linux',
      message: 'Reiniciar todo o computador físico (Debian 13)?',
      detail: 'A VM e todos os serviços serão encerrados durante a reinicialização.',
      confirmLabel: 'Reiniciar Linux Agora',
      danger: true,
    },
    shutdown: {
      title: 'Desligar PC Fisicamente',
      message: 'ATENÇÃO: o computador será desligado completamente (shutdown -h +0).',
      detail: 'Você precisará ligar a máquina fisicamente (ou via Wake-on-LAN) para acessar o MothOS novamente.',
      confirmLabel: 'Desligar PC Agora',
      danger: true,
    },
  };

  async function handleVmAction(action) {
    if (busy) return;
    const meta = VM_ACTION_META[action];
    if (!meta) return;

    if (meta.needsConfirm) {
      const ok = await confirmAction(meta);
      if (!ok) return;
    }

    setBusy(true);
    try {
      const res = await apiFetch('/api/vm/action', {
        method: 'POST',
        body: { action, confirm: true },
      });
      showToast(res.message || `Ação "${action}" enviada com sucesso.`, 'success');
      setTimeout(() => {
        if (!destroyed) {
          loadStatus();
          refreshMonitorOnce();
        }
      }, 900);
    } catch (err) {
      showToast(`Falha na ação da VM: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleHostPower(action) {
    if (busy) return;
    const meta = HOST_POWER_META[action];
    if (!meta) return;

    const ok = await confirmAction(meta);
    if (!ok) return;

    setBusy(true);
    try {
      const res = await apiFetch('/api/host/power', {
        method: 'POST',
        body: { action, confirm: true },
      });
      showToast(res.message || 'Comando de energia enviado ao host.', 'success', 5500);
    } catch (err) {
      showToast(`Erro no comando de energia: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectOpenCore(name) {
    if (busy || !name) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/vm/opencore', {
        method: 'POST',
        body: { name },
      });
      showToast(res.message || `OpenCore selecionada: ${res.selected || name}`, 'success');
      await loadStatus();
      refreshMonitorOnce();
    } catch (err) {
      showToast(`Erro ao alterar OpenCore: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  container.addEventListener('click', (e) => {
    const vmBtn = e.target.closest('button[data-vm-action]');
    if (vmBtn) {
      handleVmAction(vmBtn.dataset.vmAction);
      return;
    }
    const powerBtn = e.target.closest('button[data-host-power]');
    if (powerBtn) {
      handleHostPower(powerBtn.dataset.hostPower);
      return;
    }
    const ocBtn = e.target.closest('button[data-opencore]');
    if (ocBtn) {
      handleSelectOpenCore(ocBtn.dataset.opencore);
    }
  });

  refs.refreshBtn.addEventListener('click', loadStatus);
  loadStatus();

  return () => {
    destroyed = true;
  };
}
