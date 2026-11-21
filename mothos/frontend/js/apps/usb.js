/**
 * App 3: USB & Bluetooth Hot-Plug (Intel AX200 BT Control + QMP VM Devices + Host lsusb)
 */

import { apiFetch } from '../api.js';
import { Icons, showToast } from '../ui.js';
import { esc } from '../utils.js';

export function mountUsbApp(container) {
  let data = null;
  let busy = false;
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack usb-app">
      <!-- Intel AX200 Bluetooth Panel -->
      <div class="glass-card bt-card">
        <div class="card-header">
          <div class="title-with-icon">
            <span class="accent-badge badge-blue">${Icons.bluetooth}</span>
            <div>
              <h3 class="card-title">Intel AX200 Bluetooth</h3>
              <p class="card-subtitle" id="bt-sysfs-path">Carregando estado do Bluetooth...</p>
            </div>
          </div>
          <div class="header-actions">
            <span class="pill pill-sm pill-muted" id="bt-status-pill">—</span>
            <button type="button" class="btn btn-sm btn-ghost" id="usb-refresh-btn">
              <span class="btn-icon">${Icons.refresh}</span> Atualizar
            </button>
          </div>
        </div>

        <div class="bt-meta-row" id="bt-meta-row"></div>

        <div class="bt-actions-row">
          <button type="button" class="btn btn-primary" data-bt-action="preload_attach">Preload + Anexar</button>
          <button type="button" class="btn btn-cyan" data-bt-action="attach">Anexar</button>
          <button type="button" class="btn btn-ghost" data-bt-action="detach">Desanexar</button>
          <button type="button" class="btn btn-emerald-soft" data-bt-action="enable">Ativar</button>
          <button type="button" class="btn btn-rose-soft" data-bt-action="disable">Desativar</button>
        </div>

        <pre class="console-box hidden" id="bt-output-box"></pre>
      </div>

      <!-- Attached VM USB Devices -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">USB Anexados na VM (QMP)</h3>
            <p class="card-subtitle">Dispositivos atualmente conectados ao macOS</p>
          </div>
          <span class="pill pill-sm pill-cyan" id="vm-usb-count">0</span>
        </div>
        <div class="device-list" id="vm-usb-list">
          <div class="empty-note">Carregando dispositivos da VM...</div>
        </div>
      </div>

      <!-- Host lsusb Devices -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Dispositivos USB do Host (lsusb)</h3>
            <p class="card-subtitle">Anexe ou remova dispositivos com 1 clique via QMP xHCI</p>
          </div>
          <span class="pill pill-sm pill-muted" id="host-usb-count">0</span>
        </div>
        <div class="device-list" id="host-usb-list">
          <div class="empty-note">Lendo barramento USB do host...</div>
        </div>
      </div>
    </div>
  `;

  const refs = {
    btSysfs: container.querySelector('#bt-sysfs-path'),
    btPill: container.querySelector('#bt-status-pill'),
    btMeta: container.querySelector('#bt-meta-row'),
    btOutput: container.querySelector('#bt-output-box'),
    vmCount: container.querySelector('#vm-usb-count'),
    vmList: container.querySelector('#vm-usb-list'),
    hostCount: container.querySelector('#host-usb-count'),
    hostList: container.querySelector('#host-usb-list'),
    refreshBtn: container.querySelector('#usb-refresh-btn'),
  };

  function setBusy(val) {
    busy = val;
    container.querySelectorAll('button[data-bt-action], button[data-attach-vid], button[data-detach-id]').forEach((b) => {
      b.disabled = val;
    });
  }

  function render() {
    if (!data || destroyed) return;

    const bt = data.bt || {};
    const attached = Boolean(bt.attached);
    const enabled = Boolean(bt.enabled);
    const libusbErrors = Number(bt.libusb_errors) || 0;

    refs.btSysfs.textContent = bt.sysfs ? `Sysfs: ${bt.sysfs}` : 'Controlador Intel AX200';
    refs.btPill.className = `pill pill-sm ${attached ? 'pill-green' : enabled ? 'pill-cyan' : 'pill-muted'}`;
    refs.btPill.textContent = attached ? 'Anexado na VM' : enabled ? 'Ativo no Host' : 'Desativado';

    refs.btMeta.innerHTML = `
      <span class="pill pill-xs ${enabled ? 'pill-green' : 'pill-muted'}">Flag: ${enabled ? 'Habilitado' : 'Desabilitado'}</span>
      <span class="pill pill-xs ${attached ? 'pill-cyan' : 'pill-muted'}">VM: ${attached ? 'Conectado' : 'Livre'}</span>
      <span class="pill pill-xs ${libusbErrors > 0 ? 'pill-rose' : 'pill-green'}">Erros libusb: ${esc(libusbErrors)}</span>
    `;

    // VM USB devices
    const vmDevices = Array.isArray(data.vm_devices) ? data.vm_devices : [];
    refs.vmCount.textContent = String(vmDevices.length);
    if (vmDevices.length === 0) {
      refs.vmList.innerHTML = `<div class="empty-note">Nenhum dispositivo USB anexado à VM no momento.</div>`;
    } else {
      refs.vmList.innerHTML = vmDevices
        .map(
          (dev) => `
          <div class="device-row">
            <div class="device-main">
              <div class="device-name">${esc(dev.product || dev.id)}</div>
              <div class="device-sub mono">ID: ${esc(dev.id)} • Porta: ${esc(dev.port ?? '—')} • ${esc(dev.speed || '—')}</div>
            </div>
            <button type="button" class="btn btn-sm btn-rose-soft" data-detach-id="${esc(dev.id)}">Desanexar</button>
          </div>
        `
        )
        .join('');
    }

    // Host USB devices
    const hostDevices = Array.isArray(data.host_devices) ? data.host_devices : [];
    refs.hostCount.textContent = String(hostDevices.length);
    if (hostDevices.length === 0) {
      refs.hostList.innerHTML = `<div class="empty-note">Nenhum dispositivo USB encontrado no host.</div>`;
    } else {
      refs.hostList.innerHTML = hostDevices
        .map((dev) => {
          const isAttached = Boolean(dev.attached_to_vm);
          const actionBtn = isAttached && dev.qmp_id
            ? `<button type="button" class="btn btn-sm btn-rose-soft" data-detach-id="${esc(dev.qmp_id)}">Desanexar</button>`
            : `<button type="button" class="btn btn-sm btn-primary" data-attach-vid="${esc(dev.vid)}" data-attach-pid="${esc(dev.pid)}">Anexar</button>`;

          return `
            <div class="device-row ${isAttached ? 'device-attached' : ''}">
              <div class="device-main">
                <div class="device-name">
                  ${esc(dev.name || `${dev.vid}:${dev.pid}`)}
                  ${isAttached ? '<span class="pill pill-xs pill-green">Na VM</span>' : ''}
                </div>
                <div class="device-sub mono">
                  ${esc(dev.vid)}:${esc(dev.pid)} • Bus ${esc(dev.bus)} Dev ${esc(dev.dev)}
                  ${dev.qmp_id ? `• QMP ${esc(dev.qmp_id)}` : ''}
                </div>
              </div>
              ${actionBtn}
            </div>
          `;
        })
        .join('');
    }
  }

  async function loadUsb() {
    try {
      data = await apiFetch('/api/usb/list');
      render();
    } catch (err) {
      showToast(`Erro ao listar USB: ${err.message}`, 'error');
    }
  }

  async function runBtAction(action) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/usb/bt', {
        method: 'POST',
        body: { action },
      });
      if (res.output) {
        refs.btOutput.textContent = res.output;
        refs.btOutput.classList.remove('hidden');
      }
      showToast(res.ok ? `Bluetooth: ação "${action}" concluída.` : `Bluetooth retornou erro.`, res.ok ? 'success' : 'error');
      await loadUsb();
    } catch (err) {
      showToast(`Erro no controle Bluetooth: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function attachDevice(vid, pid) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/usb/attach', {
        method: 'POST',
        body: { vid, pid, port: null },
      });
      showToast(res.message || `Dispositivo ${vid}:${pid} anexado (${res.id || 'ok'}).`, res.ok ? 'success' : 'error');
      await loadUsb();
    } catch (err) {
      showToast(`Erro ao anexar USB: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function detachDevice(id) {
    if (busy || !id) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/usb/detach', {
        method: 'POST',
        body: { id },
      });
      showToast(res.message || `Dispositivo ${id} desanexado.`, res.ok ? 'success' : 'error');
      await loadUsb();
    } catch (err) {
      showToast(`Erro ao desanexar USB: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  container.addEventListener('click', (e) => {
    const btBtn = e.target.closest('button[data-bt-action]');
    if (btBtn) {
      runBtAction(btBtn.dataset.btAction);
      return;
    }
    const attachBtn = e.target.closest('button[data-attach-vid]');
    if (attachBtn) {
      attachDevice(attachBtn.dataset.attachVid, attachBtn.dataset.attachPid);
      return;
    }
    const detachBtn = e.target.closest('button[data-detach-id]');
    if (detachBtn) {
      detachDevice(detachBtn.dataset.detachId);
    }
  });

  refs.refreshBtn.addEventListener('click', loadUsb);
  loadUsb();

  return () => {
    destroyed = true;
  };
}
