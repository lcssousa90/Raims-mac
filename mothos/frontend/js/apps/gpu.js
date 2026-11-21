/**
 * App: GPU RTX 3070 & Desempenho (Telemetria VFIO + NullMoth 3.0 + Tuning PCIe/CPU/IRQs)
 */

import { apiFetch } from '../api.js';
import { getState, subscribe, refreshMonitorOnce } from '../store.js';
import { drawSparkline, drawGaugeRing } from '../sparkline.js';
import { Icons, showToast } from '../ui.js';
import { esc, clamp, formatMb, formatMhz, formatTemp } from '../utils.js';

export function mountGpuApp(container) {
  let busyAction = null;
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack gpu-app">
      <!-- Top GPU Status Card -->
      <div class="glass-card mon-summary-bar">
        <div class="mon-host-block">
          <div class="mon-cpu-model" id="gpu-model">NVIDIA GeForce RTX 3070</div>
          <div class="mon-sub-meta" id="gpu-sub-meta">Aguardando telemetria PCIe &amp; NullMoth...</div>
        </div>
        <div class="mon-summary-pills">
          <span class="pill pill-sm pill-muted" id="gpu-driver-pill">vfio-pci</span>
          <span class="pill pill-sm pill-muted" id="gpu-guest-pill">macOS</span>
          <button type="button" class="btn btn-sm btn-ghost" id="gpu-refresh-btn">
            <span class="btn-icon">${Icons.refresh}</span> Atualizar
          </button>
        </div>
      </div>

      <!-- Radial Gauges Row -->
      <div class="glass-card">
        <div class="gpu-gauges-grid">
          <div class="gauge-item">
            <canvas id="gpu-gauge-load" class="gauge-canvas"></canvas>
            <div class="gauge-title">Carga da GPU</div>
            <div class="gauge-sub mono" id="gpu-gauge-load-sub">—</div>
          </div>
          <div class="gauge-item">
            <canvas id="gpu-gauge-fps" class="gauge-canvas"></canvas>
            <div class="gauge-title">Flips / FPS</div>
            <div class="gauge-sub mono" id="gpu-gauge-fps-sub">—</div>
          </div>
          <div class="gauge-item">
            <canvas id="gpu-gauge-vram" class="gauge-canvas"></canvas>
            <div class="gauge-title">VRAM Alocada</div>
            <div class="gauge-sub mono" id="gpu-gauge-vram-sub">— / 8192 MB</div>
          </div>
        </div>

        <div class="gpu-kpi-strip" id="gpu-kpi-strip"></div>
      </div>

      <!-- Chart 1: GPU Load % + NullMoth FPS -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Carga da GPU (%) &amp; Taxa de Quadros (FPS)</h3>
            <p class="card-subtitle">Histórico ao vivo dos últimos 60 segundos</p>
          </div>
          <div class="mon-legend">
            <span class="legend-item legend-cyan"><i class="legend-dot"></i> Carga <strong id="gpu-c1-load">—</strong></span>
            <span class="legend-item legend-emerald"><i class="legend-dot"></i> FPS <strong id="gpu-c1-fps">—</strong></span>
          </div>
        </div>
        <div class="mon-chart-wrap">
          <canvas id="gpu-chart-load" class="sparkline-canvas" aria-label="Gráfico de carga da GPU e FPS"></canvas>
        </div>
      </div>

      <!-- Chart 2 & Chart 3 Split -->
      <div class="two-col-grid">
        <div class="glass-card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Atividade VFIO (IRQ 68/s)</h3>
              <p class="card-subtitle">Interrupções por segundo &amp; Marks Metal</p>
            </div>
            <span class="pill pill-sm pill-cyan" id="gpu-c2-irq">— /s</span>
          </div>
          <div class="mon-chart-wrap mon-chart-sm">
            <canvas id="gpu-chart-irq" class="sparkline-canvas"></canvas>
          </div>
          <div class="widget-foot" id="gpu-c2-foot">Total IRQs: — • Áudio HDMI/s: —</div>
        </div>

        <div class="glass-card">
          <div class="card-header">
            <div>
              <h3 class="card-title">VRAM Estimada &amp; Boost Ryzen</h3>
              <p class="card-subtitle">Superfícies ativas vs Clock das vCPUs</p>
            </div>
            <span class="pill pill-sm pill-indigo" id="gpu-c3-vram">— MB</span>
          </div>
          <div class="mon-chart-wrap mon-chart-sm">
            <canvas id="gpu-chart-vram" class="sparkline-canvas"></canvas>
          </div>
          <div class="widget-foot" id="gpu-c3-foot">Superfícies: — • vCPUs: —</div>
        </div>
      </div>

      <!-- Hardware & NullMoth Details -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Hardware PCIe &amp; Pipeline NullMoth</h3>
            <p class="card-subtitle">Estado do link no Linux host e saúde da aceleração no macOS</p>
          </div>
        </div>
        <div class="status-meta-grid" id="gpu-hw-grid"></div>
      </div>

      <!-- Organized Tuning & Control Buttons -->
      <div class="glass-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Otimização &amp; Controle de Desempenho</h3>
            <p class="card-subtitle">Ajustes ao vivo de PCIe, isolamento de IRQs e perfil de boost da CPU</p>
          </div>
          <span class="pill pill-sm pill-muted" id="gpu-cpu-mode-pill">Governor —</span>
        </div>

        <div class="tuning-grid">
          <button type="button" class="action-tile tile-cyan" data-gpu-action="optimize_pcie">
            <span class="tile-icon">${Icons.gpu}</span>
            <span class="tile-label">Otimizar PCIe GPU</span>
            <span class="tile-desc">MaxReadReq 4096B + IRQs</span>
          </button>

          <button type="button" class="action-tile tile-emerald" data-gpu-action="repin_irqs">
            <span class="tile-icon">${Icons.shield}</span>
            <span class="tile-label">Re-isolar IRQs &amp; VM</span>
            <span class="tile-desc">Fixar vCPUs e Host 0,5,6,11</span>
          </button>

          <button type="button" class="action-tile tile-indigo" data-gpu-action="cpu_turbo" id="btn-cpu-turbo">
            <span class="tile-icon">${Icons.bolt}</span>
            <span class="tile-label">CPU Turbo Máximo</span>
            <span class="tile-desc">Boost ON • Performance</span>
          </button>

          <button type="button" class="action-tile tile-amber" data-gpu-action="cpu_balanced" id="btn-cpu-balanced">
            <span class="tile-icon">${Icons.monitor}</span>
            <span class="tile-label">CPU Equilibrado</span>
            <span class="tile-desc">Boost ON • Economia leve</span>
          </button>
        </div>
      </div>
    </div>
  `;

  const refs = {
    model: container.querySelector('#gpu-model'),
    subMeta: container.querySelector('#gpu-sub-meta'),
    driverPill: container.querySelector('#gpu-driver-pill'),
    guestPill: container.querySelector('#gpu-guest-pill'),
    refreshBtn: container.querySelector('#gpu-refresh-btn'),
    gLoad: container.querySelector('#gpu-gauge-load'),
    gFps: container.querySelector('#gpu-gauge-fps'),
    gVram: container.querySelector('#gpu-gauge-vram'),
    gLoadSub: container.querySelector('#gpu-gauge-load-sub'),
    gFpsSub: container.querySelector('#gpu-gauge-fps-sub'),
    gVramSub: container.querySelector('#gpu-gauge-vram-sub'),
    kpiStrip: container.querySelector('#gpu-kpi-strip'),
    c1Load: container.querySelector('#gpu-c1-load'),
    c1Fps: container.querySelector('#gpu-c1-fps'),
    chartLoad: container.querySelector('#gpu-chart-load'),
    c2Irq: container.querySelector('#gpu-c2-irq'),
    chartIrq: container.querySelector('#gpu-chart-irq'),
    c2Foot: container.querySelector('#gpu-c2-foot'),
    c3Vram: container.querySelector('#gpu-c3-vram'),
    chartVram: container.querySelector('#gpu-chart-vram'),
    c3Foot: container.querySelector('#gpu-c3-foot'),
    hwGrid: container.querySelector('#gpu-hw-grid'),
    cpuModePill: container.querySelector('#gpu-cpu-mode-pill'),
    btnTurbo: container.querySelector('#btn-cpu-turbo'),
    btnBalanced: container.querySelector('#btn-cpu-balanced'),
  };

  function setBusy(actionName) {
    busyAction = actionName;
    container.querySelectorAll('button[data-gpu-action]').forEach((b) => {
      b.disabled = Boolean(actionName);
    });
  }

  function render(st) {
    if (destroyed) return;
    const data = st.monitor;
    if (!data) return;

    const gpu = data.gpu || {};
    const cpu = data.cpu || {};
    const load = clamp(Number(gpu.load_pct) || 0, 0, 100);
    const fps = Math.max(0, Number(gpu.fps) || 0);
    const vramUsed = Math.max(0, Number(gpu.vram_used_mb) || 0);
    const vramTotal = Math.max(1, Number(gpu.vram_total_mb) || 8192);
    const vramPct = clamp((vramUsed / vramTotal) * 100, 0, 100);
    const irqPs = Math.max(0, Number(gpu.irq_per_sec) || 0);
    const marksPs = Math.max(0, Number(gpu.marks_per_sec) || 0);
    const guestLive = Boolean(gpu.guest_live);

    refs.model.textContent = gpu.model || 'NVIDIA GeForce RTX 3070';
    refs.subMeta.textContent = `${gpu.pcie_speed || 'PCIe'} • ${gpu.pcie_width || 'x16'} • MaxReadReq ${gpu.max_read_req || '—'} • ${gpu.power_state || 'D0'}`;

    refs.driverPill.className = `pill pill-sm ${gpu.driver === 'vfio-pci' ? 'pill-cyan' : 'pill-muted'}`;
    refs.driverPill.textContent = gpu.driver || 'vfio-pci';

    refs.guestPill.className = `pill pill-sm ${guestLive ? 'pill-green' : 'pill-amber'}`;
    refs.guestPill.textContent = guestLive ? 'NullMoth Ao Vivo' : 'Estimado PCIe';

    // Radial Gauges
    drawGaugeRing(refs.gLoad, load, '#38bdf8', `${Math.round(load)}%`, 'CARGA');
    drawGaugeRing(refs.gFps, clamp((fps / 120) * 100, 0, 100), '#34d399', `${Math.round(fps)}`, 'FPS');
    drawGaugeRing(refs.gVram, vramPct, '#818cf8', `${vramPct.toFixed(0)}%`, 'VRAM');

    refs.gLoadSub.textContent = `${Math.round(marksPs)} marks/s`;
    refs.gFpsSub.textContent = gpu.flip_hit_pct != null ? `Hit ${Number(gpu.flip_hit_pct).toFixed(2)}%` : 'Flips/s';
    refs.gVramSub.textContent = `${formatMb(vramUsed)} / ${formatMb(vramTotal)}`;

    const timeouts = Number(gpu.gpu_timeouts) || 0;
    const waitMs = Number(gpu.wait_max_ms) || 0;
    refs.kpiStrip.innerHTML = `
      <span class="pill pill-xs ${timeouts === 0 ? 'pill-green' : 'pill-rose'}">GPU Timeouts: ${esc(timeouts)}</span>
      <span class="pill pill-xs ${waitMs < 50 ? 'pill-cyan' : 'pill-amber'}">Wait Máx: ${esc(waitMs.toFixed(1))} ms</span>
      <span class="pill pill-xs ${gpu.gpuboost ? 'pill-green' : 'pill-muted'}">gpuboost=${gpu.gpuboost ? '1' : '0/n/d'}</span>
      <span class="pill pill-xs ${(gpu.aer_errors || 0) === 0 ? 'pill-green' : 'pill-rose'}">Erros PCIe AER: ${esc(gpu.aer_errors || 0)}</span>
    `;

    // Chart 1: GPU Load % + FPS
    refs.c1Load.textContent = `${load.toFixed(0)}%`;
    refs.c1Fps.textContent = `${fps.toFixed(0)} fps`;
    const maxFps = Math.max(75, ...(st.history.gpuFps || [60]));
    drawSparkline(
      refs.chartLoad,
      [
        {
          values: st.history.gpuLoad,
          min: 0,
          max: 100,
          stroke: '#38bdf8',
          fill: true,
          fillTop: 'rgba(56, 189, 248, 0.28)',
          lineWidth: 2.2,
        },
        {
          values: st.history.gpuFps,
          min: 0,
          max: maxFps,
          stroke: '#34d399',
          fill: false,
          lineWidth: 1.9,
        },
      ],
      { grid: true, padX: 6, padY: 10, maxLabel: '100%', minLabel: '0%' }
    );

    // Chart 2: VFIO IRQ/s
    refs.c2Irq.textContent = `${irqPs.toFixed(0)} IRQ/s`;
    const maxIrq = Math.max(400, ...(st.history.gpuIrq || [100]));
    drawSparkline(
      refs.chartIrq,
      [
        {
          values: st.history.gpuIrq,
          min: 0,
          max: maxIrq,
          stroke: '#c084fc',
          fill: true,
          fillTop: 'rgba(192, 132, 252, 0.28)',
          lineWidth: 2.1,
        },
      ],
      { grid: true, padX: 6, padY: 8, maxLabel: `${Math.round(maxIrq)}/s`, minLabel: '0' }
    );
    refs.c2Foot.textContent = `Total IRQ ${gpu.irq || 68}: ${Number(gpu.irq_total || 0).toLocaleString('pt-BR')} • Áudio HDMI: ${Number(gpu.audio_irq_per_sec || 0).toFixed(1)}/s`;

    // Chart 3: VRAM + CPU MHz
    refs.c3Vram.textContent = `${Math.round(vramUsed)} MB`;
    drawSparkline(
      refs.chartVram,
      [
        {
          values: st.history.gpuVram,
          min: 0,
          max: 8192,
          stroke: '#818cf8',
          fill: true,
          fillTop: 'rgba(129, 140, 248, 0.26)',
          lineWidth: 2.1,
        },
        {
          values: st.history.mhz,
          min: 2000,
          max: 4900,
          stroke: '#fbbf24',
          fill: false,
          lineWidth: 1.6,
        },
      ],
      { grid: true, padX: 6, padY: 8, maxLabel: '8 GB', minLabel: '0' }
    );
    refs.c3Foot.textContent = `Superfícies: ${gpu.active_resources || 0} • vCPUs: ${formatMhz(cpu.avg_vcpu_mhz)} (${formatTemp(cpu.temp_tctl_c)})`;

    // Hardware details grid
    refs.hwGrid.innerHTML = `
      <div class="meta-chip">
        <span class="meta-k">Link PCIe</span>
        <strong class="meta-v mono">${esc(gpu.pcie_speed || '—')} ${esc(gpu.pcie_width || '')}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">MaxReadReq / Estado</span>
        <strong class="meta-v mono">${esc(gpu.max_read_req || '—')} • ${esc(gpu.power_state || 'D0')}</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">WindowServer / Brave GPU</span>
        <strong class="meta-v mono">${esc((gpu.windowserver_cpu || 0).toFixed(1))}% / ${esc((gpu.brave_gpu_cpu || 0).toFixed(1))}%</strong>
      </div>
      <div class="meta-chip">
        <span class="meta-k">Pool Alloc / Superfícies</span>
        <strong class="meta-v mono">${esc((gpu.pool_alloc_gb || 0).toFixed(2))} GB • ${esc(gpu.active_resources || 0)}</strong>
      </div>
    `;

    // CPU Governor pill + active tuning highlight
    const gov = cpu.governor || 'performance';
    refs.cpuModePill.className = `pill pill-sm ${gov === 'performance' ? 'pill-cyan' : 'pill-amber'}`;
    refs.cpuModePill.textContent = `CPU: ${gov}`;
    refs.btnTurbo.classList.toggle('tile-active', gov === 'performance');
    refs.btnBalanced.classList.toggle('tile-active', gov !== 'performance');
  }

  async function runAction(action) {
    if (busyAction) return;
    setBusy(action);
    try {
      const res = await apiFetch('/api/gpu/action', {
        method: 'POST',
        body: { action },
      });
      showToast(res.message || 'Ajuste aplicado com sucesso.', res.ok ? 'success' : 'error', 4200);
      refreshMonitorOnce();
    } catch (err) {
      showToast(`Erro no ajuste: ${err.message}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-gpu-action]');
    if (btn) {
      runAction(btn.dataset.gpuAction);
    }
  });
  refs.refreshBtn.addEventListener('click', () => refreshMonitorOnce());

  const unsub = subscribe(render);
  render(getState());
  refreshMonitorOnce();

  return () => {
    destroyed = true;
    unsub();
  };
}
