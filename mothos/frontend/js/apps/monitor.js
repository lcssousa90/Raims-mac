/**
 * App 1: Monitor em Tempo Real (Ryzen 12-threads, Sparklines, RAM/HugePages, Disco, IRQs)
 */

import { getState, subscribe, refreshMonitorOnce } from '../store.js';
import { drawSparkline } from '../sparkline.js';
import { esc, clamp, formatMb, formatMhz, formatTemp, formatUptime } from '../utils.js';
import { Icons } from '../ui.js';

export function mountMonitorApp(container) {
  container.innerHTML = `
    <div class="app-stack monitor-app">
      <!-- Top Summary Bar -->
      <div class="glass-card mon-summary-bar">
        <div class="mon-host-block">
          <div class="mon-cpu-model" id="mon-cpu-model">Carregando processador...</div>
          <div class="mon-sub-meta" id="mon-sub-meta">Aguardando snapshot...</div>
        </div>
        <div class="mon-summary-pills">
          <span class="pill pill-sm pill-muted" id="mon-boost-pill">Boost</span>
          <span class="pill pill-sm pill-muted" id="mon-ws-pill">WS</span>
          <button type="button" class="btn btn-sm btn-ghost" id="mon-refresh-btn">
            <span class="btn-icon">${Icons.refresh}</span> Atualizar
          </button>
        </div>
      </div>

      <!-- Live Sparkline Chart -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Clock Médio vCPU &amp; Temperatura</h3>
            <p class="card-subtitle">Histórico ao vivo (últimos 60 segundos)</p>
          </div>
          <div class="mon-legend">
            <span class="legend-item legend-cyan"><i class="legend-dot"></i> <strong id="mon-avg-mhz">—</strong></span>
            <span class="legend-item legend-amber"><i class="legend-dot"></i> Tctl <strong id="mon-tctl">—</strong></span>
            <span class="legend-item legend-rose"><i class="legend-dot"></i> Tccd1 <strong id="mon-tccd1">—</strong></span>
          </div>
        </div>
        <div class="mon-chart-wrap">
          <canvas id="mon-sparkline" class="sparkline-canvas" aria-label="Gráfico de clock vCPU e temperatura"></canvas>
        </div>
      </div>

      <!-- 12-Thread Ryzen Grid -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Threads da CPU (vCPU vs Host)</h3>
            <p class="card-subtitle">Frequência efetiva CPPC e utilização por thread</p>
          </div>
          <div class="mon-legend">
            <span class="legend-item legend-cyan"><i class="legend-dot"></i> vCPU</span>
            <span class="legend-item legend-amber"><i class="legend-dot"></i> Host</span>
          </div>
        </div>
        <div class="cores-grid" id="mon-cores-grid"></div>
      </div>

      <!-- Memory & Disk Split -->
      <div class="two-col-grid">
        <div class="glass-card">
          <div class="card-header">
            <h3 class="card-title">Memória, HugePages &amp; Swap</h3>
          </div>
          <div class="metric-bars" id="mon-memory-body"></div>
        </div>

        <div class="glass-card">
          <div class="card-header">
            <h3 class="card-title">Armazenamento</h3>
          </div>
          <div class="metric-bars" id="mon-disk-body"></div>
        </div>
      </div>

      <!-- IRQ Isolation Table -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Isolamento de Interrupções (IRQ)</h3>
            <p class="card-subtitle">Dispositivos VFIO e rede monitorados nos núcleos vCPU</p>
          </div>
          <span class="pill pill-sm pill-muted" id="mon-irq-status">—</span>
        </div>
        <div class="table-scroll">
          <table class="glass-table">
            <thead>
              <tr>
                <th>IRQ</th>
                <th>Dispositivo</th>
                <th>Afinidade</th>
                <th>Efetiva</th>
                <th class="num">Total</th>
                <th class="num">Em vCPU</th>
              </tr>
            </thead>
            <tbody id="mon-irq-tbody">
              <tr><td colspan="6" class="empty-cell">Carregando tabela de IRQs...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const refs = {
    cpuModel: container.querySelector('#mon-cpu-model'),
    subMeta: container.querySelector('#mon-sub-meta'),
    boostPill: container.querySelector('#mon-boost-pill'),
    wsPill: container.querySelector('#mon-ws-pill'),
    avgMhz: container.querySelector('#mon-avg-mhz'),
    tctl: container.querySelector('#mon-tctl'),
    tccd1: container.querySelector('#mon-tccd1'),
    canvas: container.querySelector('#mon-sparkline'),
    coresGrid: container.querySelector('#mon-cores-grid'),
    memBody: container.querySelector('#mon-memory-body'),
    diskBody: container.querySelector('#mon-disk-body'),
    irqStatus: container.querySelector('#mon-irq-status'),
    irqTbody: container.querySelector('#mon-irq-tbody'),
    refreshBtn: container.querySelector('#mon-refresh-btn'),
  };

  refs.refreshBtn.addEventListener('click', () => refreshMonitorOnce());

  function render(st) {
    const data = st.monitor;

    // WS pill
    const wsMap = {
      live: { text: 'WS Ao Vivo', cls: 'pill-green' },
      connecting: { text: 'Conectando', cls: 'pill-amber' },
      reconnecting: { text: 'Reconectando', cls: 'pill-amber' },
      offline: { text: 'Offline', cls: 'pill-rose' },
    };
    const wsInfo = wsMap[st.wsStatus] || wsMap.offline;
    refs.wsPill.className = `pill pill-sm ${wsInfo.cls}`;
    refs.wsPill.textContent = wsInfo.text;

    if (!data) return;

    const cpu = data.cpu || {};
    const mem = data.memory || {};
    const disk = data.disk || {};
    const irqs = data.irqs || {};
    const load = Array.isArray(data.load_avg) ? data.load_avg.map((v) => Number(v).toFixed(2)).join(' / ') : '—';

    refs.cpuModel.textContent = cpu.model || 'CPU';
    refs.subMeta.textContent = `${data.hostname || 'host'} • Uptime ${formatUptime(data.uptime_s)} • Load ${load}`;

    refs.boostPill.className = `pill pill-sm ${cpu.boost_enabled ? 'pill-cyan' : 'pill-muted'}`;
    refs.boostPill.textContent = cpu.boost_enabled ? 'Boost Ativo' : 'Boost Desligado';

    refs.avgMhz.textContent = formatMhz(cpu.avg_vcpu_mhz);
    refs.tctl.textContent = formatTemp(cpu.temp_tctl_c);
    refs.tccd1.textContent = formatTemp(cpu.temp_tccd1_c);

    // Sparkline
    drawSparkline(
      refs.canvas,
      [
        {
          values: st.history.mhz,
          min: 2000,
          max: 4900,
          stroke: '#38bdf8',
          fill: true,
          fillTop: 'rgba(56, 189, 248, 0.28)',
          lineWidth: 2.2,
        },
        {
          values: st.history.temp,
          min: 25,
          max: 95,
          stroke: '#fbbf24',
          fill: false,
          lineWidth: 1.8,
        },
      ],
      { grid: true, padX: 6, padY: 10 }
    );

    // Cores Grid (12 threads)
    const cores = Array.isArray(cpu.cores) ? cpu.cores : [];
    if (cores.length === 0) {
      refs.coresGrid.innerHTML = `<div class="empty-note">Nenhum núcleo reportado.</div>`;
    } else {
      refs.coresGrid.innerHTML = cores
        .map((core) => {
          const isVcpu = String(core.role).toLowerCase() === 'vcpu';
          const usage = clamp(Number(core.usage_pct) || 0, 0, 100);
          const mhz = Number(core.mhz) || 0;
          const clockPct = clamp((mhz / 4850) * 100, 5, 100);
          return `
            <div class="core-tile ${isVcpu ? 'core-vcpu' : 'core-host'}">
              <div class="core-top">
                <span class="core-id">CPU ${esc(core.id)}</span>
                <span class="core-role-tag">${isVcpu ? 'vCPU' : 'HOST'}</span>
              </div>
              <div class="core-mhz">${esc(Math.round(mhz))} <small>MHz</small></div>
              <div class="core-bar-row">
                <div class="progress-track progress-xs">
                  <div class="progress-fill ${isVcpu ? 'progress-cyan' : 'progress-amber'}" style="width: ${usage.toFixed(1)}%"></div>
                </div>
                <span class="core-pct">${usage.toFixed(0)}%</span>
              </div>
              <div class="progress-track progress-xxs" title="Frequência relativa ao boost">
                <div class="progress-fill progress-indigo-soft" style="width: ${clockPct.toFixed(1)}%"></div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    // Memory & HugePages & Swap
    const ramTotal = Number(mem.total_mb) || 0;
    const ramUsed = Number(mem.used_mb) || 0;
    const ramAvail = Number(mem.available_mb) || 0;
    const ramPct = ramTotal > 0 ? clamp((ramUsed / ramTotal) * 100, 0, 100) : 0;

    const hpTotal = Number(mem.hugepages_total) || 0;
    const hpFree = Number(mem.hugepages_free) || 0;
    const hpUsed = Math.max(0, hpTotal - hpFree);
    const hpPct = hpTotal > 0 ? clamp((hpUsed / hpTotal) * 100, 0, 100) : 0;

    const swapTotal = Number(mem.swap_total_mb) || 0;
    const swapUsed = Number(mem.swap_used_mb) || 0;
    const swapPct = swapTotal > 0 ? clamp((swapUsed / swapTotal) * 100, 0, 100) : 0;

    refs.memBody.innerHTML = `
      <div class="metric-row">
        <div class="metric-row-head">
          <span>Memória RAM</span>
          <strong>${esc(formatMb(ramUsed))} / ${esc(formatMb(ramTotal))} (${ramPct.toFixed(0)}%)</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill progress-indigo" style="width: ${ramPct.toFixed(1)}%"></div>
        </div>
        <div class="metric-row-foot">Disponível: ${esc(formatMb(ramAvail))}</div>
      </div>

      <div class="metric-row">
        <div class="metric-row-head">
          <span>HugePages (2 MB)</span>
          <strong>${esc(hpUsed)} / ${esc(hpTotal)} páginas</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill progress-cyan" style="width: ${hpPct.toFixed(1)}%"></div>
        </div>
        <div class="metric-row-foot">Livres: ${esc(hpFree)} • Alocado VM: ${esc(formatMb(hpUsed * 2))}</div>
      </div>

      <div class="metric-row">
        <div class="metric-row-head">
          <span>Swap</span>
          <strong>${esc(formatMb(swapUsed))} / ${esc(formatMb(swapTotal))}</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill progress-emerald" style="width: ${swapPct.toFixed(1)}%"></div>
        </div>
      </div>
    `;

    // Disk
    const rootPct = clamp(Number(disk.root_pct) || 0, 0, 100);
    const vmDisk = Number(disk.vm_disk_gb) || 0;
    const vmVirtual = Number(disk.vm_disk_virtual_gb) || 0;
    const vmDiskPct = vmVirtual > 0 ? clamp((vmDisk / vmVirtual) * 100, 0, 100) : 0;

    refs.diskBody.innerHTML = `
      <div class="metric-row">
        <div class="metric-row-head">
          <span>Partição Raiz (<code>/</code>)</span>
          <strong>${esc(Number(disk.root_used_gb || 0).toFixed(1))} / ${esc(Number(disk.root_total_gb || 0).toFixed(1))} GB (${rootPct.toFixed(0)}%)</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${rootPct > 85 ? 'progress-rose' : 'progress-cyan'}" style="width: ${rootPct.toFixed(1)}%"></div>
        </div>
        <div class="metric-row-foot">Espaço livre: ${esc(Number(disk.root_free_gb || 0).toFixed(1))} GB</div>
      </div>

      <div class="metric-row">
        <div class="metric-row-head">
          <span>Disco da VM (<code>disk.qcow2</code>)</span>
          <strong>${esc(vmDisk.toFixed(1))} / ${esc(vmVirtual.toFixed(0))} GB</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill progress-indigo" style="width: ${vmDiskPct.toFixed(1)}%"></div>
        </div>
        <div class="metric-row-foot">Alocação real em disco vs tamanho virtual</div>
      </div>
    `;

    // IRQs
    const leaked = Number(irqs.vcpu_leaked_count) || 0;
    const clean = Boolean(irqs.vcpu_clean) && leaked === 0;
    refs.irqStatus.className = `pill pill-sm ${clean ? 'pill-green' : 'pill-rose'}`;
    refs.irqStatus.textContent = clean ? '0 leaks em vCPU' : `${leaked} leaks detectados`;

    const items = Array.isArray(irqs.items) ? irqs.items : [];
    if (items.length === 0) {
      refs.irqTbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Nenhuma IRQ monitorada no momento.</td></tr>`;
    } else {
      refs.irqTbody.innerHTML = items
        .map((item) => {
          const onVcpu = Number(item.on_vcpu) || 0;
          const isLeak = onVcpu > 0;
          return `
            <tr class="${isLeak ? 'row-warn' : ''}">
              <td class="mono">${esc(item.irq)}</td>
              <td class="mono cell-wrap">${esc(item.name)}</td>
              <td class="mono">${esc(item.affinity)}</td>
              <td class="mono">${esc(item.effective)}</td>
              <td class="num mono">${esc(Number(item.total || 0).toLocaleString('pt-BR'))}</td>
              <td class="num mono">
                <span class="pill pill-xs ${isLeak ? 'pill-rose' : 'pill-green'}">${esc(onVcpu.toLocaleString('pt-BR'))}</span>
              </td>
            </tr>
          `;
        })
        .join('');
    }
  }

  const unsub = subscribe(render);
  const onResize = () => render(getState());
  window.addEventListener('resize', onResize);

  render(getState());
  refreshMonitorOnce();

  return () => {
    unsub();
    window.removeEventListener('resize', onResize);
  };
}
