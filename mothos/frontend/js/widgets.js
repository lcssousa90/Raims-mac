/**
 * MothOS Free-Placement Resizable Widget Board
 * — All 12 Resource Widgets, Any-Spot Drag & Corner Resize (Touch + Mouse Pointer Events),
 * Per-Screen Persistent Coordinates (Wide / Compact), Live Telemetry & 1-Tap Controls.
 */

import { apiFetch } from './api.js';
import { getState, refreshMonitorOnce } from './store.js';
import { drawChartVariant, drawCoreBars, drawGaugeRing } from './sparkline.js';
import { Icons, showToast, confirmAction } from './ui.js';
import { esc, clamp, formatMb, formatMhz, formatTemp, formatUptime, stripAnsi } from './utils.js';

const STORAGE_PREFIX = 'mothos.home.widgets.v2.';
const LEGACY_STORAGE_KEY = 'mothos.home.widgets.v1';

const DEFAULT_WIDGET_IDS = ['cpu', 'gpu', 'vm', 'ram_irq', 'dualboot', 'usb_bt'];

const CHART_STYLE_LABELS = {
  area: 'Área',
  bars: 'Barras',
  gauge: 'Medidor',
  step: 'Onda',
  meter: 'LED',
};

export const WIDGET_CATALOG = [
  { id: 'cpu', title: 'CPU Ryzen 5600X', desc: 'Clock, uso %, temp e governor', tab: 'monitor', icon: Icons.monitor, grad: 'icon-grad-cyan', chartModes: ['area', 'bars', 'gauge', 'step', 'meter'], defaultChart: 'area' },
  { id: 'gpu', title: 'GPU RTX 3070', desc: 'Carga, FPS, VRAM, PCIe e IRQ 68', tab: 'gpu', icon: Icons.gpu, grad: 'icon-grad-emerald', chartModes: ['area', 'bars', 'gauge', 'step', 'meter'], defaultChart: 'area' },
  { id: 'vm', title: 'VM macOS & OpenCore', desc: 'Status QMP, Watchdog e energia da VM', tab: 'vm', icon: Icons.vm, grad: 'icon-grad-indigo' },
  { id: 'ram_irq', title: 'RAM, HugePages & IRQs', desc: 'Memória, histórico e isolamento das vCPUs', tab: 'monitor', icon: Icons.shield, grad: 'icon-grad-cyan', chartModes: ['area', 'bars', 'gauge', 'step', 'meter'], defaultChart: 'area' },
  { id: 'chart_gauges', title: 'Painel de Medidores', desc: 'Gauges circulares ou LEDs de CPU, GPU e RAM', tab: 'gpu', icon: Icons.gpu, grad: 'icon-grad-cyan', chartModes: ['gauge', 'meter'], defaultChart: 'gauge' },
  { id: 'chart_cores', title: 'Ryzen 12 Threads', desc: 'Gráfico ao vivo das 12 threads vCPU vs Host', tab: 'monitor', icon: Icons.monitor, grad: 'icon-grad-cyan', chartModes: ['bars', 'meter'], defaultChart: 'bars' },
  { id: 'chart_fps_irq', title: 'Gráfico FPS & IRQ 68', desc: 'Taxa de quadros NullMoth e atividade VFIO', tab: 'gpu', icon: Icons.bolt, grad: 'icon-grad-emerald', chartModes: ['area', 'bars', 'step', 'gauge', 'meter'], defaultChart: 'step' },
  { id: 'chart_vram_ram', title: 'Gráfico VRAM & RAM', desc: 'Uso combinado de VRAM RTX 3070 e RAM do host', tab: 'monitor', icon: Icons.shield, grad: 'icon-grad-indigo', chartModes: ['area', 'bars', 'step', 'gauge', 'meter'], defaultChart: 'bars' },
  { id: 'storage', title: 'Discos & Armazenamento', desc: 'Raiz / e alocação disk.qcow2', tab: 'files', icon: Icons.files, grad: 'icon-grad-sky' },
  { id: 'dualboot', title: 'Dual-Boot & Energia PC', desc: 'Windows, reboot e desligar host', tab: 'vm', icon: Icons.power, grad: 'icon-grad-indigo' },
  { id: 'tuning', title: 'Tuning GPU & CPU', desc: 'MaxReadReq 4096B, IRQs e Turbo', tab: 'gpu', icon: Icons.bolt, grad: 'icon-grad-emerald' },
  { id: 'usb_bt', title: 'USB & Bluetooth AX200', desc: 'Contagem USB e controles AX200', tab: 'usb', icon: Icons.usb, grad: 'icon-grad-blue' },
  { id: 'files', title: 'Arquivos & Atalhos', desc: 'Pastas favoritas com abertura direta', tab: 'files', icon: Icons.folder, grad: 'icon-grad-sky' },
  { id: 'updates', title: 'Updates APT & Serviços', desc: 'Pacotes pendentes e unidades systemd', tab: 'updates', icon: Icons.updates, grad: 'icon-grad-amber' },
  { id: 'logs', title: 'Logs ao Vivo', desc: 'Últimas linhas de MothOS, QEMU e dmesg', tab: 'terminal', icon: Icons.code, grad: 'icon-grad-violet' },
  { id: 'shell', title: 'Shell Rápido', desc: 'Chips e execução direta no bash', tab: 'terminal', icon: Icons.terminal, grad: 'icon-grad-violet' },
];

const CATALOG_MAP = Object.fromEntries(WIDGET_CATALOG.map((w) => [w.id, w]));
const LAZY_IDS = new Set(['usb_bt', 'files', 'updates', 'logs']);

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function hasLayoutOverlap(items) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (rectsOverlap(items[i], items[j])) return true;
    }
  }
  return false;
}

export function resolveLayoutCollisions(items, pinnedId, targetRect, cols, options = {}) {
  const working = items.map((it) => ({ ...it }));
  const pinned = pinnedId ? working.find((it) => it.id === pinnedId) : null;

  if (pinned && targetRect) {
    pinned.w = clamp(Math.round(targetRect.w), 1, cols);
    pinned.h = Math.max(1, Math.round(targetRect.h));
    pinned.x = clamp(Math.round(targetRect.x), 0, cols - pinned.w);
    pinned.y = Math.max(0, Math.round(targetRect.y));
  }

  for (const it of working) {
    it.w = clamp(Math.round(it.w), 1, cols);
    it.h = Math.max(1, Math.round(it.h));
    it.x = clamp(Math.round(it.x), 0, cols - it.w);
    it.y = Math.max(0, Math.round(it.y));
  }

  // Phase 1: Smart direct displacement for widgets overlapping the active widget
  if (pinned) {
    const baseRect = options.baseRect || null;
    const allowSwapFrom = options.allowSwapFrom || null;
    const allowPushRight = Boolean(options.allowPushRight);
    const directHits = working
      .filter((it) => it.id !== pinned.id && rectsOverlap(pinned, it))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));

    let swapUsed = false;
    for (const hit of directHits) {
      // 1a. During drag, swap hit into dragged widget's old spot if it fits cleanly
      if (!swapUsed && allowSwapFrom) {
        const sx = clamp(Math.round(allowSwapFrom.x), 0, cols - hit.w);
        const sy = Math.max(0, Math.round(allowSwapFrom.y));
        const swapCand = { x: sx, y: sy, w: hit.w, h: hit.h };
        const blocked = working.some((o) => o.id !== hit.id && rectsOverlap(swapCand, o));
        if (!blocked) {
          hit.x = sx;
          hit.y = sy;
          swapUsed = true;
          continue;
        }
      }

      // 1b. During resize, shift right-hand neighbors right on the same row if free
      if (allowPushRight && baseRect && hit.x >= baseRect.x + baseRect.w) {
        const rightX = pinned.x + pinned.w;
        if (rightX + hit.w <= cols) {
          const rightCand = { x: rightX, y: hit.y, w: hit.w, h: hit.h };
          const blocked = working.some((o) => o.id !== hit.id && rectsOverlap(rightCand, o));
          if (!blocked) {
            hit.x = rightX;
            continue;
          }
        }
      }

      // 1c. Default: push cleanly below the pinned widget
      hit.y = pinned.y + pinned.h;
    }
  }

  // Phase 2: Full transitive push-down cascade guaranteeing zero overlaps
  const origIndex = new Map(working.map((it, idx) => [it.id, idx]));
  const order = [...working];
  for (let guard = 0; guard < 500; guard += 1) {
    order.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (origIndex.get(a.id) - origIndex.get(b.id)));
    let changed = false;
    for (let i = 0; i < order.length; i += 1) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j += 1) {
        const b = order[j];
        if (!rectsOverlap(a, b)) continue;
        if (pinned && b.id === pinned.id) {
          a.y = b.y + b.h;
        } else {
          b.y = a.y + a.h;
        }
        changed = true;
        break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }

  return working;
}

function findFreeSpotIn(items, w, h, cols) {
  const width = clamp(w, 1, cols);
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x <= cols - width; x += 1) {
      const candidate = { x, y, w: width, h };
      if (!items.some((other) => rectsOverlap(candidate, other))) {
        return { x, y };
      }
    }
  }
  const maxY = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  return { x: 0, y: maxY };
}

function defaultLayoutFor(mode) {
  if (mode === 'compact') {
    return DEFAULT_WIDGET_IDS.map((id, idx) => ({
      id,
      x: 0,
      y: idx * 3,
      w: 6,
      h: 3,
      z: idx + 1,
      chart: CATALOG_MAP[id]?.defaultChart || null,
    }));
  }
  return DEFAULT_WIDGET_IDS.map((id, idx) => ({
    id,
    x: (idx % 3) * 4,
    y: Math.floor(idx / 3) * 3,
    w: 4,
    h: 3,
    z: idx + 1,
    chart: CATALOG_MAP[id]?.defaultChart || null,
  }));
}

function normalizeItem(raw, metrics, fallbackZ = 1) {
  if (!raw || typeof raw.id !== 'string' || !CATALOG_MAP[raw.id]) return null;
  const meta = CATALOG_MAP[raw.id];
  const w = clamp(Math.round(Number(raw.w) || (metrics.mode === 'wide' ? 4 : 6)), metrics.minW, metrics.cols);
  const h = clamp(Math.round(Number(raw.h) || 3), metrics.minH, metrics.maxH);
  const x = clamp(Math.round(Number(raw.x) || 0), 0, metrics.cols - w);
  const y = Math.max(0, Math.round(Number(raw.y) || 0));
  const z = Math.max(1, Math.round(Number(raw.z) || fallbackZ));
  const chart =
    Array.isArray(meta.chartModes) && meta.chartModes.includes(raw.chart)
      ? raw.chart
      : meta.defaultChart || null;
  return { id: raw.id, x, y, w, h, z, chart };
}

function loadLayoutFor(metrics) {
  const key = STORAGE_PREFIX + metrics.mode;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set();
        const valid = [];
        for (let i = 0; i < parsed.length; i += 1) {
          const item = normalizeItem(parsed[i], metrics, i + 1);
          if (item && !seen.has(item.id)) {
            seen.add(item.id);
            valid.push(item);
          }
        }
        if (hasLayoutOverlap(valid)) {
          const cleaned = resolveLayoutCollisions(valid, null, null, metrics.cols);
          saveLayoutFor(metrics.mode, cleaned);
          return cleaned;
        }
        return valid;
      }
    }

    // One-time migration from v1 list layout
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (Array.isArray(legacy)) {
        const seen = new Set();
        const migrated = [];
        for (let i = 0; i < legacy.length; i += 1) {
          const id = legacy[i] && typeof legacy[i].id === 'string' ? legacy[i].id : null;
          if (!id || !CATALOG_MAP[id] || seen.has(id)) continue;
          seen.add(id);
          const w = metrics.mode === 'wide' ? (legacy[i].span === 2 ? 8 : 4) : 6;
          const h = 3;
          const spot = findFreeSpotIn(migrated, w, h, metrics.cols);
          migrated.push({ id, x: spot.x, y: spot.y, w, h, z: i + 1, chart: CATALOG_MAP[id].defaultChart || null });
        }
        saveLayoutFor(metrics.mode, migrated);
        return migrated;
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return defaultLayoutFor(metrics.mode);
}

function saveLayoutFor(mode, layout) {
  try {
    localStorage.setItem(STORAGE_PREFIX + mode, JSON.stringify(layout));
  } catch {
    // Ignore storage write errors
  }
}

export function createWidgetBoard({ boardEl, pickerEl, manageBtn, editBtn, onNavigateTab }) {
  function getGridMetrics() {
    const width = (boardEl && boardEl.clientWidth) || Math.max(320, window.innerWidth - 32);
    if (width >= 640) {
      const cols = 12;
      const gap = 12;
      const rowH = 68;
      const cellW = (width - gap * (cols - 1)) / cols;
      return {
        mode: 'wide',
        boardWidth: width,
        cols,
        minW: 3,
        minH: 2,
        maxH: 10,
        gap,
        rowH,
        cellW,
        stepX: cellW + gap,
        stepY: rowH + gap,
      };
    }
    const cols = 6;
    const gap = 10;
    const rowH = 68;
    const cellW = (width - gap * (cols - 1)) / cols;
    return {
      mode: 'compact',
      boardWidth: width,
      cols,
      minW: 3,
      minH: 2,
      maxH: 10,
      gap,
      rowH,
      cellW,
      stepX: cellW + gap,
      stepY: rowH + gap,
    };
  }

  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_PX = 10;

  let currentMetrics = getGridMetrics();
  let layout = loadLayoutFor(currentMetrics);
  let editMode = false;
  let pickerOpen = false;
  let isActive = false;
  let lazyTimer = null;
  let activeInteraction = null;
  let longPress = null;
  let justDraggedUntil = 0;

  let logSource = 'mothos';
  let shellOutput = '';
  let shellBusy = false;

  const cache = {
    usb: null,
    bookmarks: null,
    apt: null,
    services: null,
    logs: null,
  };

  // Inline Edit Mode Banner inserted right above the board
  const editBannerEl = document.createElement('div');
  editBannerEl.className = 'widget-edit-banner glass-panel hidden';
  editBannerEl.setAttribute('role', 'status');
  editBannerEl.innerHTML = `
    <span class="widget-edit-banner-text"><strong>Modo de Edição</strong> — arraste qualquer widget, redimensione pelo canto ◢ ou toque fora para sair</span>
    <div class="widget-edit-banner-actions">
      <button type="button" class="btn btn-xs btn-cyan-soft" data-eb-picker="1">+ Widgets</button>
      <button type="button" class="btn btn-xs btn-ghost" data-eb-pack="1">Auto-organizar</button>
      <button type="button" class="btn btn-xs btn-primary" data-eb-done="1">Concluir</button>
    </div>
  `;
  if (boardEl && boardEl.parentElement) {
    boardEl.parentElement.insertBefore(editBannerEl, boardEl);
  }

  function isPlaced(id) {
    return layout.some((item) => item.id === id);
  }

  function maxZIndex() {
    return layout.reduce((m, item) => Math.max(m, item.z || 1), 1);
  }

  function updateToolbarButtons() {
    if (editBtn) {
      editBtn.classList.toggle('btn-active', editMode);
      editBtn.textContent = editMode ? 'Concluir' : 'Organizar';
    }
    if (manageBtn) {
      manageBtn.classList.toggle('btn-active', pickerOpen);
    }
  }

  function setEditMode(next) {
    const target = Boolean(next);
    if (editMode === target) return;
    editMode = target;
    if (boardEl) boardEl.classList.toggle('edit-mode', editMode);
    if (editBannerEl) editBannerEl.classList.toggle('hidden', !editMode);
    updateToolbarButtons();
    positionAllCards();
  }

  function renderPicker() {
    if (!pickerEl) return;
    pickerEl.classList.toggle('hidden', !pickerOpen);
    updateToolbarButtons();
    if (!pickerOpen) return;

    pickerEl.innerHTML = `
      <div class="widget-picker-head">
        <div>
          <h3 class="card-title">Widgets Disponíveis (${layout.length}/${WIDGET_CATALOG.length})</h3>
          <p class="card-subtitle">Segure em qualquer widget para entrar no Modo de Edição, arrastar e redimensionar</p>
        </div>
        <div class="widget-picker-actions">
          <button type="button" class="btn btn-xs btn-cyan-soft" data-picker-all="1">Adicionar todos</button>
          <button type="button" class="btn btn-xs btn-ghost" data-picker-pack="1">Auto-organizar</button>
          <button type="button" class="btn btn-xs btn-ghost" data-picker-reset="1">Restaurar padrão</button>
          <button type="button" class="btn btn-xs btn-primary" data-picker-close="1">Concluir</button>
        </div>
      </div>
      <div class="widget-picker-grid">
        ${WIDGET_CATALOG.map((meta) => {
          const active = isPlaced(meta.id);
          return `
            <div class="widget-picker-item ${active ? 'placed' : ''}">
              <span class="picker-item-icon ${esc(meta.grad)}">${meta.icon}</span>
              <div class="picker-item-info">
                <div class="picker-item-title">${esc(meta.title)}</div>
                <div class="picker-item-desc">${esc(meta.desc)}</div>
              </div>
              <button type="button" class="btn btn-xs ${active ? 'btn-rose-soft' : 'btn-emerald-soft'}" data-picker-toggle="${esc(meta.id)}">
                ${active ? 'Remover' : '+ Adicionar'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function cardInnerMarkup(id, item = null) {
    const chartStyle = item?.chart || CATALOG_MAP[id]?.defaultChart || 'area';
    switch (id) {
      case 'cpu':
        return `
          <div class="widget-metric-row">
            <div class="widget-value" data-w-cpu-mhz>—</div>
            <div class="widget-subvalue" data-w-cpu-temp>— °C</div>
          </div>
          <div class="hero-sparkline-wrap">
            <canvas id="wb-cpu-sparkline" class="sparkline-canvas" aria-label="Clock CPU"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-cpu-meta>Governor: — • EPP: —</div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-cyan" data-gpu-act="cpu_turbo">Turbo</button>
            <button type="button" class="quick-pill-btn" data-gpu-act="cpu_balanced">Balanceado</button>
          </div>
        `;
      case 'gpu':
        return `
          <div class="widget-metric-row">
            <div class="widget-value" data-w-gpu-load>—%</div>
            <div class="widget-subvalue text-emerald" data-w-gpu-fps>— FPS</div>
          </div>
          <div class="hero-sparkline-wrap">
            <canvas id="wb-gpu-sparkline" class="sparkline-canvas" aria-label="Carga GPU RTX 3070"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-gpu-meta>VRAM: — / 8192 MB • IRQ: —/s</div>
          <div class="widget-actions-row">
            <span class="pill pill-xs pill-muted" data-w-gpu-src>VFIO</span>
            <button type="button" class="quick-pill-btn qp-green" data-gpu-act="optimize_pcie">PCIe 4096B</button>
          </div>
        `;
      case 'vm':
        return `
          <div class="widget-value widget-value-md" data-w-vm-oc>—</div>
          <div class="widget-meta-line mono" data-w-vm-meta>PID — • QMP — • Watchdog —</div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-green" data-vm-act="start">Iniciar</button>
            <button type="button" class="quick-pill-btn qp-amber" data-vm-act="shutdown">ACPI Off</button>
            <button type="button" class="quick-pill-btn qp-cyan" data-vm-act="restart">Reiniciar</button>
          </div>
        `;
      case 'ram_irq':
        return `
          <div class="widget-metric-row">
            <div class="widget-value widget-value-md" data-w-ram-used>—</div>
            <span class="widget-pct" data-w-ram-pct>—%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill progress-indigo" data-w-ram-bar style="width: 0%"></div>
          </div>
          <div class="hero-sparkline-wrap">
            <canvas id="wb-ram-chart" class="sparkline-canvas" aria-label="Uso de RAM e IRQs"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-hp-meta>HugePages: —/—</div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-cyan" data-gpu-act="repin_irqs">Re-isolar IRQs</button>
          </div>
        `;
      case 'chart_gauges':
        return `
          <div class="widget-gauges-trio ${chartStyle === 'meter' ? 'hidden' : ''}" id="wb-gauges-trio">
            <div class="widget-gauge-cell"><canvas id="wb-g-cpu" class="sparkline-canvas"></canvas></div>
            <div class="widget-gauge-cell"><canvas id="wb-g-gpu" class="sparkline-canvas"></canvas></div>
            <div class="widget-gauge-cell"><canvas id="wb-g-ram" class="sparkline-canvas"></canvas></div>
          </div>
          <div class="widget-chart-fill ${chartStyle === 'meter' ? '' : 'hidden'}" id="wb-gauges-meter-wrap">
            <canvas id="wb-g-meter" class="sparkline-canvas"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-gauges-meta>CPU — • GPU — • RAM —</div>
        `;
      case 'chart_cores':
        return `
          <div class="widget-chart-fill">
            <canvas id="wb-cores-chart" class="sparkline-canvas" aria-label="Ryzen 12 Threads"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-cores-meta>vCPU (azul) • Host (âmbar) • Média — MHz</div>
        `;
      case 'chart_fps_irq':
        return `
          <div class="widget-metric-row">
            <div class="widget-value text-emerald" data-w-c-fps>— FPS</div>
            <div class="widget-subvalue" data-w-c-irq>IRQ —/s</div>
          </div>
          <div class="widget-chart-fill">
            <canvas id="wb-fps-irq-chart" class="sparkline-canvas" aria-label="FPS e IRQ 68"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-c-fps-meta>Marks: —/s • Flip Hit: —%</div>
        `;
      case 'chart_vram_ram':
        return `
          <div class="widget-metric-row">
            <div class="widget-value widget-value-md" data-w-c-vram>— / 8192 MB</div>
            <div class="widget-pct" data-w-c-ram>RAM —%</div>
          </div>
          <div class="widget-chart-fill">
            <canvas id="wb-vram-ram-chart" class="sparkline-canvas" aria-label="VRAM e RAM"></canvas>
          </div>
          <div class="widget-meta-line mono" data-w-c-mem-meta>HugePages: —/— • Boost —</div>
        `;
      case 'storage':
        return `
          <div class="widget-disk-list">
            <div class="widget-disk-row">
              <div class="widget-disk-head"><span>Raiz /</span><strong class="mono" data-w-disk-root>—</strong></div>
              <div class="progress-track progress-xs"><div class="progress-fill progress-cyan" data-w-disk-bar style="width: 0%"></div></div>
            </div>
            <div class="widget-disk-row">
              <div class="widget-disk-head"><span>disk.qcow2</span><strong class="mono" data-w-disk-vm>—</strong></div>
            </div>
          </div>
          <div class="widget-meta-line mono" data-w-disk-free>Espaço livre: — GB</div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-cyan" data-open-tab="files">Abrir Arquivos</button>
          </div>
        `;
      case 'dualboot':
        return `
          <div class="widget-meta-line mono" data-w-host-meta>Host: — • Uptime —</div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-win" data-host-act="boot_windows">Windows</button>
            <button type="button" class="quick-pill-btn qp-amber" data-host-act="reboot">Reiniciar PC</button>
            <button type="button" class="quick-pill-btn qp-rose" data-host-act="shutdown">Desligar PC</button>
          </div>
        `;
      case 'tuning':
        return `
          <div class="widget-pills-wrap" data-w-tuning-pills>
            <span class="pill pill-xs pill-muted">Gov: —</span>
            <span class="pill pill-xs pill-muted">EPP: —</span>
            <span class="pill pill-xs pill-muted">MRR: —</span>
            <span class="pill pill-xs pill-muted">IRQs: —</span>
          </div>
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn qp-green" data-gpu-act="optimize_pcie">PCIe 4096B</button>
            <button type="button" class="quick-pill-btn qp-cyan" data-gpu-act="repin_irqs">Re-isolar IRQs</button>
            <button type="button" class="quick-pill-btn qp-amber" data-gpu-act="cpu_turbo">CPU Turbo</button>
            <button type="button" class="quick-pill-btn" data-gpu-act="cpu_balanced">Balanceado</button>
          </div>
        `;
      case 'usb_bt':
        return `<div class="widget-lazy-body" id="wb-usb-body"><div class="widget-meta-line">Carregando USB &amp; AX200...</div></div>`;
      case 'files':
        return `<div class="widget-lazy-body" id="wb-files-body"><div class="widget-meta-line">Carregando atalhos...</div></div>`;
      case 'updates':
        return `<div class="widget-lazy-body" id="wb-updates-body"><div class="widget-meta-line">Consultando APT &amp; systemd...</div></div>`;
      case 'logs':
        return `<div class="widget-lazy-body" id="wb-logs-body"><div class="widget-meta-line">Carregando logs...</div></div>`;
      case 'shell':
        return `
          <div class="widget-actions-row">
            <button type="button" class="quick-pill-btn" data-shell-cmd="uptime">uptime</button>
            <button type="button" class="quick-pill-btn" data-shell-cmd="free -h">free -h</button>
            <button type="button" class="quick-pill-btn" data-shell-cmd="df -h">df -h</button>
            <button type="button" class="quick-pill-btn" data-shell-cmd="lspci -nnk -s 07:00">RTX 3070</button>
            <button type="button" class="quick-pill-btn" data-shell-cmd="/root/bt-control.sh status">BT status</button>
          </div>
          <form class="widget-shell-form" id="wb-shell-form">
            <span class="term-prompt-symbol mono">$</span>
            <input type="text" id="wb-shell-input" class="widget-shell-input mono" placeholder="Comando rápido..." autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
            <button type="submit" class="btn btn-xs btn-primary">Rodar</button>
          </form>
          <div class="widget-mini-shell-wrap ${shellOutput ? '' : 'hidden'}" id="wb-shell-out-wrap">
            <pre class="widget-mini-log mono" id="wb-shell-out">${esc(shellOutput)}</pre>
            <button type="button" class="btn btn-xs btn-ghost widget-shell-clear" id="wb-shell-clear">Limpar</button>
          </div>
        `;
      default:
        return '';
    }
  }

  function itemRectPx(item, m) {
    const w = clamp(item.w, m.minW, m.cols);
    const x = clamp(item.x, 0, m.cols - w);
    const h = clamp(item.h, m.minH, m.maxH);
    const y = Math.max(0, item.y);
    return {
      left: Math.round(x * m.stepX),
      top: Math.round(y * m.stepY),
      width: Math.round(w * m.cellW + (w - 1) * m.gap),
      height: Math.round(h * m.rowH + (h - 1) * m.gap),
    };
  }

  function positionAllCards(extraRows = 0) {
    if (!boardEl) return;
    currentMetrics = getGridMetrics();
    const m = currentMetrics;
    let maxBottomRow = 0;

    for (const item of layout) {
      item.w = clamp(item.w, m.minW, m.cols);
      item.x = clamp(item.x, 0, m.cols - item.w);
      item.h = clamp(item.h, m.minH, m.maxH);
      item.y = Math.max(0, item.y);
    }

    if (!activeInteraction && hasLayoutOverlap(layout)) {
      const fixed = resolveLayoutCollisions(layout, null, null, m.cols);
      const byId = new Map(fixed.map((it) => [it.id, it]));
      for (const item of layout) {
        const next = byId.get(item.id);
        if (next) {
          item.x = next.x;
          item.y = next.y;
          item.w = next.w;
          item.h = next.h;
        }
      }
      saveLayoutFor(m.mode, layout);
    }

    for (const item of layout) {
      maxBottomRow = Math.max(maxBottomRow, item.y + item.h);
      const card = boardEl.querySelector(`article[data-widget-id="${item.id}"]`);
      if (card) {
        const px = itemRectPx(item, m);
        card.style.left = `${px.left}px`;
        card.style.top = `${px.top}px`;
        card.style.width = `${px.width}px`;
        card.style.height = `${px.height}px`;
        card.style.zIndex = String(item.z || 1);
      }
    }

    const padRows = editMode ? 4 : 2;
    const minPx = Math.max(540, Math.ceil((maxBottomRow + padRows + extraRows) * m.stepY));
    boardEl.style.minHeight = `${minPx}px`;
  }

  function render() {
    if (!boardEl) return;
    currentMetrics = getGridMetrics();
    boardEl.classList.toggle('edit-mode', editMode);
    updateToolbarButtons();

    if (layout.length === 0) {
      boardEl.innerHTML = `
        <button type="button" class="widget-empty-slot" data-open-picker="1">
          <span class="widget-add-plus">${Icons.plus}</span>
          <strong>Adicionar Widget</strong>
          <span>Clique para escolher widgets e posicionar em qualquer lugar da tela</span>
        </button>
      `;
      boardEl.style.minHeight = '360px';
      renderPicker();
      return;
    }

    const cardsHtml = layout
      .map((item) => {
        const meta = CATALOG_MAP[item.id];
        if (!meta) return '';
        const hasChartModes = Array.isArray(meta.chartModes) && meta.chartModes.length > 1;
        return `
          <article class="widget-card glass-panel" data-widget-id="${esc(meta.id)}">
            <div class="widget-top">
              <div class="widget-title-group widget-head-link" data-open-tab="${esc(meta.tab)}" role="button" tabindex="0">
                <span class="widget-mini-icon ${esc(meta.grad)}">${meta.icon}</span>
                <span class="widget-label">${esc(meta.title)}</span>
              </div>
              <div class="widget-top-right">
                <span class="pill pill-xs pill-muted" data-w-pill>—</span>
                ${
                  hasChartModes
                    ? `<button type="button" class="widget-style-btn" data-w-chart="${esc(meta.id)}" title="Trocar variação de gráfico">${esc(CHART_STYLE_LABELS[item.chart] || 'Gráfico')}</button>`
                    : ''
                }
                <button type="button" class="widget-drag-handle" data-w-drag="${esc(meta.id)}" title="Arrastar para qualquer canto da tela" aria-label="Arrastar ${esc(meta.title)}">⋮⋮</button>
                <button type="button" class="widget-remove-btn" data-w-remove="${esc(meta.id)}" title="Remover widget" aria-label="Remover ${esc(meta.title)}">×</button>
              </div>
            </div>
            <div class="widget-body-slot">${cardInnerMarkup(meta.id, item)}</div>
            <div class="widget-resize-handle" data-w-resize="${esc(meta.id)}" title="Arraste para redimensionar largura e altura" aria-label="Redimensionar ${esc(meta.title)}"></div>
          </article>
        `;
      })
      .join('');

    boardEl.innerHTML = cardsHtml;
    positionAllCards();

    renderPicker();
    patchMonitor(getState());
    renderUsbWidget();
    renderFilesWidget();
    renderUpdatesWidget();
    renderLogsWidget();
    syncShellForm();
  }

  function patchCard(id, fn) {
    if (!boardEl) return;
    const el = boardEl.querySelector(`article[data-widget-id="${id}"]`);
    if (el) fn(el);
  }

  function layoutChart(id) {
    const item = layout.find((i) => i.id === id);
    return item?.chart || CATALOG_MAP[id]?.defaultChart || 'area';
  }

  function patchMonitor(st) {
    const data = st && st.monitor;
    if (!data || !boardEl) return;
    const cpu = data.cpu || {};
    const gpu = data.gpu || {};
    const vm = data.vm || {};
    const mem = data.memory || {};
    const disk = data.disk || {};
    const irqs = data.irqs || {};

    const avgUse = clamp(Number(cpu.avg_usage_pct) || 0, 0, 100);
    const avgMhz = Number(cpu.avg_vcpu_mhz) || 0;
    const tctl = Number(cpu.temp_tctl_c);
    const gLoad = clamp(Number(gpu.load_pct) || 0, 0, 100);
    const gFps = Math.max(0, Number(gpu.fps) || 0);
    const gVram = Number(gpu.vram_used_mb) || 0;
    const gVramTot = Number(gpu.vram_total_mb) || 8192;
    const gVramPct = clamp((gVram / gVramTot) * 100, 0, 100);
    const gIrqSec = Math.max(0, Number(gpu.irq_per_sec) || 0);
    const totalMb = Number(mem.total_mb) || 0;
    const usedMb = Number(mem.used_mb) || 0;
    const ramPct = totalMb > 0 ? clamp((usedMb / totalMb) * 100, 0, 100) : 0;
    const hpTotal = Number(mem.hugepages_total) || 0;
    const hpUsed = Math.max(0, hpTotal - (Number(mem.hugepages_free) || 0));

    // 1. CPU
    patchCard('cpu', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      const boost = Boolean(cpu.boost_enabled);
      pill.className = `pill pill-xs ${boost ? 'pill-cyan' : 'pill-muted'}`;
      pill.textContent = `${avgUse.toFixed(0)}% • ${boost ? 'Boost ON' : 'OFF'}`;
      card.querySelector('[data-w-cpu-mhz]').textContent = formatMhz(avgMhz);
      card.querySelector('[data-w-cpu-temp]').textContent = formatTemp(tctl);
      card.querySelector('[data-w-cpu-meta]').textContent = `Gov: ${cpu.governor || '—'} • EPP: ${cpu.epp || '—'}`;
      const canvas = card.querySelector('#wb-cpu-sparkline');
      if (isActive && canvas) {
        drawChartVariant(canvas, layoutChart('cpu'), {
          series: [
            { values: st.history.mhz, min: 2200, max: 4900, stroke: '#38bdf8', fill: true, fillTop: 'rgba(56, 189, 248, 0.34)', lineWidth: 2 },
            { values: st.history.temp, min: 30, max: 90, stroke: '#fbbf24', fill: false, lineWidth: 1.5 },
          ],
          gauge: {
            pct: avgUse,
            color: '#38bdf8',
            label: `${Math.round(avgUse)}%`,
            sublabel: `${Math.round(avgMhz)} MHz`,
          },
          meterRows: [
            { label: 'Uso CPU', valueText: `${avgUse.toFixed(0)}%`, pct: avgUse, color: '#38bdf8' },
            { label: 'Clock vCPU', valueText: `${Math.round(avgMhz)} MHz`, pct: clamp(((avgMhz - 2200) / 2700) * 100, 0, 100), color: '#818cf8' },
          ],
          options: { grid: false, padX: 2, padY: 4 },
        });
      }
    });

    // 2. GPU
    patchCard('gpu', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = `PCIe ${gpu.pcie_width || 'x16'}`;
      card.querySelector('[data-w-gpu-load]').textContent = `${gLoad.toFixed(0)}%`;
      card.querySelector('[data-w-gpu-fps]').textContent = `${gFps.toFixed(0)} FPS`;
      card.querySelector('[data-w-gpu-meta]').textContent = `VRAM: ${Math.round(gVram)} / ${gVramTot} MB • IRQ: ${Math.round(gIrqSec)}/s`;
      const srcEl = card.querySelector('[data-w-gpu-src]');
      srcEl.className = `pill pill-xs ${gpu.guest_live ? 'pill-green' : 'pill-muted'}`;
      srcEl.textContent = gpu.guest_live ? 'NullMoth Ao Vivo' : (gpu.driver || 'vfio-pci');
      const canvas = card.querySelector('#wb-gpu-sparkline');
      if (isActive && canvas) {
        drawChartVariant(canvas, layoutChart('gpu'), {
          series: [
            { values: st.history.gpuLoad, min: 0, max: 100, stroke: '#34d399', fill: true, fillTop: 'rgba(52, 211, 153, 0.3)', lineWidth: 2 },
            { values: st.history.gpuFps, min: 0, max: 144, stroke: '#38bdf8', fill: false, lineWidth: 1.5 },
          ],
          gauge: {
            pct: gLoad,
            color: '#34d399',
            label: `${Math.round(gLoad)}%`,
            sublabel: `${Math.round(gFps)} FPS`,
          },
          meterRows: [
            { label: 'Carga GPU', valueText: `${gLoad.toFixed(0)}%`, pct: gLoad, color: '#34d399' },
            { label: 'VRAM', valueText: `${Math.round(gVram)} MB`, pct: gVramPct, color: '#c084fc' },
          ],
          options: { grid: false, padX: 2, padY: 4 },
        });
      }
    });

    // 3. VM
    patchCard('vm', (card) => {
      const online = Boolean(vm.running);
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${online ? 'pill-green' : 'pill-muted'}`;
      pill.textContent = online ? 'Online' : 'Offline';
      card.querySelector('[data-w-vm-oc]').textContent = vm.opencore || 'Sem OpenCore';
      card.querySelector('[data-w-vm-meta]').textContent =
        `PID ${vm.pid || '—'} • QMP ${vm.qmp_connected ? 'OK' : 'Off'} • WD ${vm.watchdog_active ? 'ativo' : 'inativo'}`;
    });

    // 4. RAM & IRQs
    patchCard('ram_irq', (card) => {
      const leaked = Number(irqs.vcpu_leaked_count) || 0;
      const clean = Boolean(irqs.vcpu_clean) && leaked === 0;
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${clean ? 'pill-green' : 'pill-rose'}`;
      pill.textContent = clean ? '0 leaks' : `${leaked} leaks`;
      card.querySelector('[data-w-ram-used]').textContent = `${formatMb(usedMb)} / ${formatMb(totalMb)}`;
      card.querySelector('[data-w-ram-pct]').textContent = `${ramPct.toFixed(0)}%`;
      card.querySelector('[data-w-ram-bar]').style.width = `${ramPct.toFixed(1)}%`;
      card.querySelector('[data-w-hp-meta]').textContent = `HugePages: ${hpUsed}/${hpTotal} • Aloc. VM: ${formatMb(hpUsed * 2)}`;
      const canvas = card.querySelector('#wb-ram-chart');
      if (isActive && canvas) {
        const hpPct = hpTotal > 0 ? clamp((hpUsed / hpTotal) * 100, 0, 100) : 0;
        drawChartVariant(canvas, layoutChart('ram_irq'), {
          series: [
            { values: st.history.ramPct, min: 0, max: 100, stroke: '#818cf8', fill: true, fillTop: 'rgba(129, 140, 248, 0.3)', lineWidth: 2 },
          ],
          gauge: {
            pct: ramPct,
            color: '#818cf8',
            label: `${Math.round(ramPct)}%`,
            sublabel: formatMb(usedMb),
          },
          meterRows: [
            { label: 'RAM Host', valueText: formatMb(usedMb), pct: ramPct, color: '#818cf8' },
            { label: 'HugePages', valueText: `${hpUsed}/${hpTotal}`, pct: hpPct, color: '#38bdf8' },
          ],
          options: { grid: false, padX: 2, padY: 4 },
        });
      }
    });

    // 5. Painel de Medidores (3 Gauges ou 3 Barras LED)
    patchCard('chart_gauges', (card) => {
      const style = layoutChart('chart_gauges');
      const pill = card.querySelector('[data-w-pill]');
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = style === 'meter' ? 'LEDs' : 'Gauges';
      card.querySelector('[data-w-gauges-meta]').textContent =
        `CPU ${avgUse.toFixed(0)}% • GPU ${gLoad.toFixed(0)}% (${gFps.toFixed(0)} FPS) • RAM ${ramPct.toFixed(0)}%`;
      const trio = card.querySelector('#wb-gauges-trio');
      const meterWrap = card.querySelector('#wb-gauges-meter-wrap');
      if (trio && meterWrap) {
        trio.classList.toggle('hidden', style === 'meter');
        meterWrap.classList.toggle('hidden', style !== 'meter');
      }
      if (!isActive) return;
      if (style === 'meter') {
        const mc = card.querySelector('#wb-g-meter');
        drawChartVariant(mc, 'meter', {
          meterRows: [
            { label: 'CPU', valueText: `${avgUse.toFixed(0)}%`, pct: avgUse, color: '#38bdf8' },
            { label: 'GPU', valueText: `${gLoad.toFixed(0)}%`, pct: gLoad, color: '#34d399' },
            { label: 'RAM', valueText: `${ramPct.toFixed(0)}%`, pct: ramPct, color: '#818cf8' },
          ],
        });
      } else {
        drawGaugeRing(card.querySelector('#wb-g-cpu'), avgUse, '#38bdf8', `${Math.round(avgUse)}%`, 'CPU', { fit: true });
        drawGaugeRing(card.querySelector('#wb-g-gpu'), gLoad, '#34d399', `${Math.round(gLoad)}%`, 'GPU', { fit: true });
        drawGaugeRing(card.querySelector('#wb-g-ram'), ramPct, '#818cf8', `${Math.round(ramPct)}%`, 'RAM', { fit: true });
      }
    });

    // 6. Ryzen 12 Threads (Equalizador / LED por Núcleo)
    patchCard('chart_cores', (card) => {
      const style = layoutChart('chart_cores');
      const cores = Array.isArray(cpu.cores) ? cpu.cores : [];
      const pill = card.querySelector('[data-w-pill]');
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = `${avgUse.toFixed(0)}%`;
      card.querySelector('[data-w-cores-meta]').textContent =
        `vCPU (azul) • Host (âmbar) • Média ${formatMhz(avgMhz)} (${cores.length} threads)`;
      if (isActive) {
        drawCoreBars(card.querySelector('#wb-cores-chart'), cores, { style });
      }
    });

    // 7. Gráfico FPS & IRQ 68
    patchCard('chart_fps_irq', (card) => {
      const style = layoutChart('chart_fps_irq');
      const flipHit = Number(gpu.flip_hit_pct);
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${flipHit >= 95 ? 'pill-green' : 'pill-cyan'}`;
      pill.textContent = Number.isFinite(flipHit) ? `${flipHit.toFixed(0)}% hit` : 'VFIO';
      card.querySelector('[data-w-c-fps]').textContent = `${gFps.toFixed(0)} FPS`;
      card.querySelector('[data-w-c-irq]').textContent = `IRQ ${Math.round(gIrqSec)}/s`;
      card.querySelector('[data-w-c-fps-meta]').textContent =
        `Marks: ${Math.round(Number(gpu.marks_per_sec) || 0)}/s • Flip Hit: ${Number.isFinite(flipHit) ? flipHit.toFixed(1) : '—'}%`;
      if (isActive) {
        const irqMax = Math.max(200, ...(st.history.gpuIrq || [0]));
        drawChartVariant(card.querySelector('#wb-fps-irq-chart'), style, {
          series: [
            { values: st.history.gpuFps, min: 0, max: 144, stroke: '#34d399', fill: true, fillTop: 'rgba(52, 211, 153, 0.3)', lineWidth: 2 },
            { values: st.history.gpuIrq, min: 0, max: irqMax, stroke: '#38bdf8', fill: false, lineWidth: 1.5 },
          ],
          gauge: {
            pct: clamp((gFps / 120) * 100, 0, 100),
            color: '#34d399',
            label: `${Math.round(gFps)}`,
            sublabel: 'FPS',
          },
          meterRows: [
            { label: 'NullMoth FPS', valueText: `${gFps.toFixed(0)}`, pct: clamp((gFps / 120) * 100, 0, 100), color: '#34d399' },
            { label: 'IRQ 68/s', valueText: `${Math.round(gIrqSec)}`, pct: clamp((gIrqSec / irqMax) * 100, 0, 100), color: '#38bdf8' },
          ],
          options: { grid: true, maxLabel: '144 FPS', minLabel: '0' },
        });
      }
    });

    // 8. Gráfico VRAM & RAM
    patchCard('chart_vram_ram', (card) => {
      const style = layoutChart('chart_vram_ram');
      const pill = card.querySelector('[data-w-pill]');
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = `VRAM ${gVramPct.toFixed(0)}%`;
      card.querySelector('[data-w-c-vram]').textContent = `${Math.round(gVram)} / ${gVramTot} MB`;
      card.querySelector('[data-w-c-ram]').textContent = `RAM ${ramPct.toFixed(0)}%`;
      card.querySelector('[data-w-c-mem-meta]').textContent =
        `HugePages: ${hpUsed}/${hpTotal} • Host: ${formatMb(usedMb)} • GPUBoost: ${gpu.gpuboost ? 'ON' : 'OFF'}`;
      if (isActive) {
        drawChartVariant(card.querySelector('#wb-vram-ram-chart'), style, {
          series: [
            { values: st.history.gpuVram, min: 0, max: gVramTot, stroke: '#c084fc', fill: true, fillTop: 'rgba(192, 132, 252, 0.3)', lineWidth: 2 },
            { values: st.history.ramPct, min: 0, max: 100, stroke: '#818cf8', fill: false, lineWidth: 1.6 },
          ],
          gauge: {
            pct: gVramPct,
            color: '#c084fc',
            label: `${Math.round(gVramPct)}%`,
            sublabel: `${Math.round(gVram)} MB`,
          },
          meterRows: [
            { label: 'VRAM 3070', valueText: `${Math.round(gVram)} MB`, pct: gVramPct, color: '#c084fc' },
            { label: 'RAM Host', valueText: `${ramPct.toFixed(0)}%`, pct: ramPct, color: '#818cf8' },
          ],
          options: { grid: true, maxLabel: `${Math.round(gVramTot / 1024)} GB`, minLabel: '0' },
        });
      }
    });

    // 5. Storage
    patchCard('storage', (card) => {
      const rootPct = clamp(Number(disk.root_pct) || 0, 0, 100);
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${rootPct > 85 ? 'pill-rose' : 'pill-cyan'}`;
      pill.textContent = `${rootPct.toFixed(0)}% usado`;
      card.querySelector('[data-w-disk-root]').textContent =
        `${Number(disk.root_used_gb || 0).toFixed(1)} / ${Number(disk.root_total_gb || 0).toFixed(0)} GB`;
      card.querySelector('[data-w-disk-bar]').style.width = `${rootPct.toFixed(1)}%`;
      card.querySelector('[data-w-disk-vm]').textContent =
        `${Number(disk.vm_disk_gb || 0).toFixed(1)} / ${Number(disk.vm_disk_virtual_gb || 0).toFixed(0)} GB`;
      card.querySelector('[data-w-disk-free]').textContent = `Espaço livre: ${Number(disk.root_free_gb || 0).toFixed(1)} GB`;
    });

    // 6. Dual-Boot & Host Power
    patchCard('dualboot', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      pill.className = 'pill pill-xs pill-green';
      pill.textContent = 'Host Online';
      card.querySelector('[data-w-host-meta]').textContent =
        `${data.hostname || 'debian'} • Uptime ${formatUptime(data.uptime_s)}`;
    });

    // 7. Tuning
    patchCard('tuning', (card) => {
      const leaked = Number(irqs.vcpu_leaked_count) || 0;
      const clean = Boolean(irqs.vcpu_clean) && leaked === 0;
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${gpu.max_read_req === '4096B' && clean ? 'pill-green' : 'pill-amber'}`;
      pill.textContent = gpu.max_read_req || 'PCIe';
      card.querySelector('[data-w-tuning-pills]').innerHTML = `
        <span class="pill pill-xs ${cpu.governor === 'performance' ? 'pill-amber' : 'pill-muted'}">Gov: ${esc(cpu.governor || '—')}</span>
        <span class="pill pill-xs pill-cyan">EPP: ${esc(cpu.epp || '—')}</span>
        <span class="pill pill-xs ${gpu.max_read_req === '4096B' ? 'pill-green' : 'pill-muted'}">MRR: ${esc(gpu.max_read_req || '—')}</span>
        <span class="pill pill-xs ${clean ? 'pill-green' : 'pill-rose'}">IRQs: ${clean ? 'Isoladas' : `${leaked} leaks`}</span>
      `;
    });

    // 12. Shell status pill
    patchCard('shell', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${shellBusy ? 'pill-amber' : 'pill-green'}`;
      pill.textContent = shellBusy ? 'Executando...' : 'Bash Pronto';
    });
  }

  function renderUsbWidget() {
    patchCard('usb_bt', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      const body = card.querySelector('#wb-usb-body');
      if (!cache.usb) {
        pill.className = 'pill pill-xs pill-muted';
        pill.textContent = '...';
        return;
      }
      const bt = cache.usb.bt || {};
      const attached = Boolean(bt.attached);
      const enabled = Boolean(bt.enabled);
      const vmDevs = Array.isArray(cache.usb.vm_devices) ? cache.usb.vm_devices : [];
      const hostDevs = Array.isArray(cache.usb.host_devices) ? cache.usb.host_devices : [];

      pill.className = `pill pill-xs ${attached ? 'pill-green' : enabled ? 'pill-cyan' : 'pill-muted'}`;
      pill.textContent = attached ? 'Anexado na VM' : enabled ? 'Ativo no Host' : 'Desativado';

      body.innerHTML = `
        <div class="widget-meta-line mono">VM: ${vmDevs.length} USB • Host: ${hostDevs.length} dispositivos • Erros: ${Number(bt.libusb_errors) || 0}</div>
        <div class="widget-actions-row">
          <button type="button" class="quick-pill-btn qp-cyan" data-bt-act="preload_attach">Preload+Anexar</button>
          <button type="button" class="quick-pill-btn" data-bt-act="detach">Desanexar</button>
          <button type="button" class="quick-pill-btn qp-green" data-bt-act="enable">Ativar</button>
          <button type="button" class="quick-pill-btn qp-rose" data-bt-act="disable">Desativar</button>
          <button type="button" class="quick-pill-btn" data-widget-refresh="usb_bt" title="Atualizar">↻</button>
        </div>
      `;
    });
  }

  function renderFilesWidget() {
    patchCard('files', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      const body = card.querySelector('#wb-files-body');
      const bms = cache.bookmarks;
      if (!Array.isArray(bms)) {
        pill.className = 'pill pill-xs pill-muted';
        pill.textContent = '...';
        return;
      }
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = `${bms.length} atalhos`;
      body.innerHTML = `
        <div class="widget-bookmarks">
          ${bms
            .map(
              (b) => `
            <button type="button" class="quick-pill-btn" data-open-path="${esc(b.path)}" title="${esc(b.path)}">
              ${esc(b.label)}
            </button>
          `
            )
            .join('')}
        </div>
      `;
    });
  }

  function renderUpdatesWidget() {
    patchCard('updates', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      const body = card.querySelector('#wb-updates-body');
      if (!cache.apt && !cache.services) {
        pill.className = 'pill pill-xs pill-muted';
        pill.textContent = '...';
        return;
      }
      const apt = cache.apt || {};
      const svcs = Array.isArray(cache.services) ? cache.services : [];
      const activeSvcs = svcs.filter((s) => s.active === 'active').length;
      const count = Number(apt.upgradable_count) || 0;
      const running = Boolean(apt.running);

      pill.className = `pill pill-xs ${running ? 'pill-amber' : count > 0 ? 'pill-cyan' : 'pill-green'}`;
      pill.textContent = running ? 'Verificando...' : `${count} pendentes`;

      body.innerHTML = `
        <div class="widget-meta-line mono">APT: ${esc(apt.task || 'idle')} • Serviços: ${activeSvcs}/${svcs.length} ativos</div>
        <div class="widget-actions-row">
          <button type="button" class="quick-pill-btn qp-amber" data-apt-check="1" ${running ? 'disabled' : ''}>Verificar APT</button>
          <button type="button" class="quick-pill-btn qp-cyan" data-open-tab="updates">Abrir Updates</button>
          <button type="button" class="quick-pill-btn" data-widget-refresh="updates" title="Atualizar">↻</button>
        </div>
      `;
    });
  }

  function renderLogsWidget() {
    patchCard('logs', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      const body = card.querySelector('#wb-logs-body');
      pill.className = 'pill pill-xs pill-cyan';
      pill.textContent = logSource.toUpperCase();

      const lines = Array.isArray(cache.logs) ? cache.logs.slice(-6) : null;
      const preview = lines
        ? (lines.length ? lines.join('\n') : '(sem linhas recentes)')
        : 'Carregando logs...';

      body.innerHTML = `
        <div class="widget-actions-row">
          ${[
            ['mothos', 'MothOS'],
            ['qemu', 'QEMU'],
            ['watchdog', 'Watchdog'],
            ['dmesg', 'dmesg'],
          ]
            .map(
              ([src, label]) => `
            <button type="button" class="quick-pill-btn ${logSource === src ? 'qp-cyan' : ''}" data-log-src="${src}">${label}</button>
          `
            )
            .join('')}
          <button type="button" class="quick-pill-btn" data-widget-refresh="logs" title="Atualizar">↻</button>
        </div>
        <pre class="widget-mini-log mono">${esc(preview)}</pre>
      `;
    });
  }

  function syncShellForm() {
    patchCard('shell', (card) => {
      const pill = card.querySelector('[data-w-pill]');
      pill.className = `pill pill-xs ${shellBusy ? 'pill-amber' : 'pill-green'}`;
      pill.textContent = shellBusy ? 'Executando...' : 'Bash Pronto';
      const wrap = card.querySelector('#wb-shell-out-wrap');
      const out = card.querySelector('#wb-shell-out');
      if (wrap && out) {
        wrap.classList.toggle('hidden', !shellOutput);
        out.textContent = shellOutput;
      }
    });
  }

  async function refreshLazyWidget(id) {
    if (!getState().authenticated) return;
    try {
      if (id === 'usb_bt') {
        cache.usb = await apiFetch('/api/usb/list');
        renderUsbWidget();
      } else if (id === 'files') {
        const res = await apiFetch('/api/files/bookmarks');
        cache.bookmarks = Array.isArray(res.bookmarks) ? res.bookmarks : [];
        renderFilesWidget();
      } else if (id === 'updates') {
        const [aptRes, svcRes] = await Promise.all([
          apiFetch('/api/updates/status'),
          apiFetch('/api/services/list'),
        ]);
        cache.apt = aptRes;
        cache.services = Array.isArray(svcRes.services) ? svcRes.services : [];
        renderUpdatesWidget();
      } else if (id === 'logs') {
        const res = await apiFetch(`/api/logs?source=${encodeURIComponent(logSource)}&lines=8`);
        cache.logs = Array.isArray(res.lines) ? res.lines : [];
        renderLogsWidget();
      }
    } catch {
      // Fail softly inside compact dashboard widgets
    }
  }

  function refreshAllPlacedLazy() {
    if (!isActive || !getState().authenticated) return;
    for (const item of layout) {
      if (LAZY_IDS.has(item.id)) refreshLazyWidget(item.id);
    }
  }

  function syncLazyTimer() {
    clearInterval(lazyTimer);
    lazyTimer = null;
    if (isActive && getState().authenticated && layout.some((i) => LAZY_IDS.has(i.id))) {
      lazyTimer = setInterval(refreshAllPlacedLazy, 15000);
    }
  }

  async function runShellCommand(command) {
    const cmd = String(command || '').trim();
    if (!cmd || shellBusy) return;
    shellBusy = true;
    syncShellForm();
    try {
      const res = await apiFetch('/api/terminal/exec', { method: 'POST', body: { command: cmd } });
      const text = stripAnsi(res.output || `(rc=${res.returncode ?? 0})`).trim();
      shellOutput = `$ ${cmd}\n${text || '(sem saída)'}`;
    } catch (err) {
      shellOutput = `$ ${cmd}\n[erro: ${err.message}]`;
    } finally {
      shellBusy = false;
      syncShellForm();
    }
  }

  function toggleWidget(id) {
    if (!CATALOG_MAP[id]) return;
    const idx = layout.findIndex((w) => w.id === id);
    if (idx >= 0) {
      layout.splice(idx, 1);
    } else {
      const m = getGridMetrics();
      const w = m.mode === 'wide' ? 4 : 6;
      const h = 3;
      const spot = findFreeSpotIn(layout, w, h, m.cols);
      layout.push({
        id,
        x: spot.x,
        y: spot.y,
        w,
        h,
        z: maxZIndex() + 1,
        chart: CATALOG_MAP[id]?.defaultChart || null,
      });
      if (LAZY_IDS.has(id)) refreshLazyWidget(id);
    }
    saveLayoutFor(currentMetrics.mode, layout);
    syncLazyTimer();
    render();
  }

  function autoPackLayout() {
    const m = getGridMetrics();
    const packed = [];
    for (const item of layout) {
      const w = clamp(item.w, m.minW, m.cols);
      const h = clamp(item.h, m.minH, m.maxH);
      const spot = findFreeSpotIn(packed, w, h, m.cols);
      packed.push({
        id: item.id,
        x: spot.x,
        y: spot.y,
        w,
        h,
        z: item.z || 1,
        chart: item.chart || CATALOG_MAP[item.id]?.defaultChart || null,
      });
    }
    layout = packed;
    saveLayoutFor(m.mode, layout);
    render();
  }

  // --- FREE DRAG & CORNER RESIZE (TOUCH + MOUSE POINTER EVENTS) ---

  function startInteraction(type, id, e) {
    const item = layout.find((it) => it.id === id);
    const card = boardEl.querySelector(`article[data-widget-id="${id}"]`);
    if (!item || !card) return;

    e.preventDefault();
    e.stopPropagation();

    const m = getGridMetrics();
    currentMetrics = m;
    const startPx = itemRectPx(item, m);
    const baseLayout = layout.map((it) => ({ ...it }));
    const baseById = new Map(baseLayout.map((it) => [it.id, it]));
    const baseRect = { x: item.x, y: item.y, w: item.w, h: item.h };

    item.z = maxZIndex() + 1;
    card.style.zIndex = String(item.z);
    card.classList.add('is-interacting');

    const ghost = document.createElement('div');
    ghost.className = 'widget-drop-ghost';
    ghost.style.left = `${startPx.left}px`;
    ghost.style.top = `${startPx.top}px`;
    ghost.style.width = `${startPx.width}px`;
    ghost.style.height = `${startPx.height}px`;
    boardEl.appendChild(ghost);

    const badge = document.createElement('div');
    badge.className = 'widget-size-badge pill pill-xs pill-cyan mono';
    badge.textContent = `c${item.x + 1},l${item.y + 1} • ${item.w}×${item.h}`;
    card.appendChild(badge);

    activeInteraction = {
      type,
      id,
      pointerId: e.pointerId,
      captureEl: e.currentTarget,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: startPx.left,
      startTop: startPx.top,
      startW: startPx.width,
      startH: startPx.height,
      nx: item.x,
      ny: item.y,
      nw: item.w,
      nh: item.h,
      moved: false,
      metrics: m,
      item,
      card,
      ghost,
      badge,
      baseLayout,
      baseById,
      baseRect,
      previewLayout: null,
      lastGridKey: `${item.x},${item.y},${item.w},${item.h}`,
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Fallback gracefully when capture is unavailable
    }
  }

  function cancelLongPress() {
    if (!longPress) return;
    clearTimeout(longPress.timer);
    longPress = null;
  }

  function updateCollisionPreview(ctx) {
    const key = `${ctx.nx},${ctx.ny},${ctx.nw},${ctx.nh}`;
    if (key === ctx.lastGridKey) return;
    ctx.lastGridKey = key;

    const m = ctx.metrics;
    ctx.previewLayout = resolveLayoutCollisions(
      ctx.baseLayout,
      ctx.id,
      { x: ctx.nx, y: ctx.ny, w: ctx.nw, h: ctx.nh },
      m.cols,
      {
        baseRect: ctx.baseRect,
        allowSwapFrom: ctx.type === 'drag' ? ctx.baseRect : null,
        allowPushRight: ctx.type === 'resize',
      }
    );

    let maxBottomRow = 0;
    for (const it of ctx.previewLayout) {
      maxBottomRow = Math.max(maxBottomRow, it.y + it.h);
      if (it.id === ctx.id) continue;
      const otherCard = boardEl.querySelector(`article[data-widget-id="${it.id}"]`);
      if (otherCard) {
        const px = itemRectPx(it, m);
        otherCard.style.left = `${px.left}px`;
        otherCard.style.top = `${px.top}px`;
        const base = ctx.baseById.get(it.id);
        otherCard.classList.toggle('is-displaced', Boolean(base && (it.x !== base.x || it.y !== base.y)));
      }
    }

    const neededPx = Math.ceil((maxBottomRow + 4) * m.stepY);
    const curMin = parseInt(boardEl.style.minHeight || '0', 10) || 0;
    if (neededPx > curMin) {
      boardEl.style.minHeight = `${neededPx}px`;
    }
  }

  function onPointerMove(e) {
    if (longPress && e.pointerId === longPress.pointerId) {
      longPress.curX = e.clientX;
      longPress.curY = e.clientY;
      if (Math.hypot(e.clientX - longPress.startX, e.clientY - longPress.startY) > MOVE_CANCEL_PX) {
        cancelLongPress();
      }
    }

    if (!activeInteraction || e.pointerId !== activeInteraction.pointerId) return;
    const ctx = activeInteraction;
    const m = ctx.metrics;
    const dx = e.clientX - ctx.startX;
    const dy = e.clientY - ctx.startY;
    if (Math.hypot(dx, dy) > 4) ctx.moved = true;

    if (ctx.type === 'drag') {
      ctx.card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      ctx.nx = clamp(Math.round((ctx.startLeft + dx) / m.stepX), 0, m.cols - ctx.item.w);
      ctx.ny = Math.max(0, Math.round((ctx.startTop + dy) / m.stepY));
      ctx.nw = ctx.item.w;
      ctx.nh = ctx.item.h;

      const gx = Math.round(ctx.nx * m.stepX);
      const gy = Math.round(ctx.ny * m.stepY);
      ctx.ghost.style.left = `${gx}px`;
      ctx.ghost.style.top = `${gy}px`;

      const neededPx = Math.ceil((ctx.ny + ctx.nh + 3) * m.stepY);
      const curMin = parseInt(boardEl.style.minHeight || '0', 10) || 0;
      if (neededPx > curMin) {
        boardEl.style.minHeight = `${neededPx}px`;
      }
    } else {
      const minPxW = Math.round(m.minW * m.cellW + (m.minW - 1) * m.gap);
      const minPxH = Math.round(m.minH * m.rowH + (m.minH - 1) * m.gap);
      const maxPxW = m.boardWidth - ctx.startLeft;
      const maxPxH = Math.round(m.maxH * m.rowH + (m.maxH - 1) * m.gap);

      const rawW = clamp(ctx.startW + dx, minPxW, maxPxW);
      const rawH = clamp(ctx.startH + dy, minPxH, maxPxH);
      ctx.card.style.width = `${Math.round(rawW)}px`;
      ctx.card.style.height = `${Math.round(rawH)}px`;

      ctx.nx = ctx.item.x;
      ctx.ny = ctx.item.y;
      ctx.nw = clamp(Math.round((rawW + m.gap) / m.stepX), m.minW, m.cols - ctx.item.x);
      ctx.nh = clamp(Math.round((rawH + m.gap) / m.stepY), m.minH, m.maxH);

      ctx.ghost.style.width = `${Math.round(ctx.nw * m.cellW + (ctx.nw - 1) * m.gap)}px`;
      ctx.ghost.style.height = `${Math.round(ctx.nh * m.rowH + (ctx.nh - 1) * m.gap)}px`;
    }

    updateCollisionPreview(ctx);
    ctx.badge.textContent = `c${ctx.nx + 1},l${ctx.ny + 1} • ${ctx.nw}×${ctx.nh}`;
  }

  function finishInteraction(e) {
    if (longPress && e.pointerId === longPress.pointerId) {
      cancelLongPress();
    }

    if (!activeInteraction || e.pointerId !== activeInteraction.pointerId) return;
    const ctx = activeInteraction;
    activeInteraction = null;

    if (ctx.moved) {
      justDraggedUntil = Date.now() + 260;
    }

    try {
      if (ctx.captureEl && ctx.captureEl.hasPointerCapture && ctx.captureEl.hasPointerCapture(e.pointerId)) {
        ctx.captureEl.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }

    ctx.card.style.transform = '';
    ctx.card.classList.remove('is-interacting');
    for (const el of boardEl.querySelectorAll('.widget-card.is-displaced')) {
      el.classList.remove('is-displaced');
    }
    ctx.ghost.remove();
    ctx.badge.remove();

    const resolved =
      ctx.previewLayout ||
      resolveLayoutCollisions(
        ctx.baseLayout,
        ctx.id,
        { x: ctx.nx, y: ctx.ny, w: ctx.nw, h: ctx.nh },
        ctx.metrics.cols,
        {
          baseRect: ctx.baseRect,
          allowSwapFrom: ctx.type === 'drag' ? ctx.baseRect : null,
          allowPushRight: ctx.type === 'resize',
        }
      );

    const byId = new Map(resolved.map((it) => [it.id, it]));
    for (const it of layout) {
      const next = byId.get(it.id);
      if (next) {
        it.x = next.x;
        it.y = next.y;
        it.w = next.w;
        it.h = next.h;
      }
    }

    saveLayoutFor(currentMetrics.mode, layout);
    positionAllCards();

    const st = getState();
    patchMonitor(st);
    requestAnimationFrame(() => patchMonitor(getState()));
  }

  boardEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (editMode) {
      const resizeHandle = e.target.closest('[data-w-resize]');
      if (resizeHandle) {
        startInteraction('resize', resizeHandle.dataset.wResize, e);
        return;
      }
      if (e.target.closest('button[data-w-remove], button[data-w-chart]')) {
        return;
      }
      const card = e.target.closest('article[data-widget-id]');
      if (card) {
        startInteraction('drag', card.dataset.widgetId, e);
      }
      return;
    }

    // Outside editMode: click-and-hold (450ms) anywhere on a widget enters Edit Mode cleanly
    const card = e.target.closest('article[data-widget-id]');
    if (!card || e.target.closest('input, textarea, select')) return;

    cancelLongPress();
    const lp = {
      pointerId: e.pointerId,
      id: card.dataset.widgetId,
      card,
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      timer: null,
    };
    lp.timer = setTimeout(() => {
      if (!longPress || longPress.pointerId !== lp.pointerId) return;
      longPress = null;
      try {
        if (navigator.vibrate) navigator.vibrate(25);
      } catch {
        // Ignore when vibration API is blocked
      }
      setEditMode(true);
      justDraggedUntil = Date.now() + 350;
      startInteraction('drag', lp.id, {
        pointerId: lp.pointerId,
        clientX: lp.curX,
        clientY: lp.curY,
        currentTarget: lp.card,
        preventDefault() {},
        stopPropagation() {},
      });
    }, LONG_PRESS_MS);
    longPress = lp;
  });

  boardEl.addEventListener('contextmenu', (e) => {
    if (editMode || longPress || Date.now() < justDraggedUntil) {
      e.preventDefault();
    }
  });

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finishInteraction);
  window.addEventListener('pointercancel', finishInteraction);

  async function handleBoardClick(e) {
    if (Date.now() < justDraggedUntil) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    const openPickerBtn = e.target.closest('[data-open-picker]');
    if (openPickerBtn) {
      pickerOpen = true;
      renderPicker();
      return;
    }

    const chartBtn = e.target.closest('button[data-w-chart]');
    if (chartBtn) {
      e.stopPropagation();
      const id = chartBtn.dataset.wChart;
      const item = layout.find((w) => w.id === id);
      const meta = CATALOG_MAP[id];
      if (item && meta && Array.isArray(meta.chartModes) && meta.chartModes.length > 1) {
        const nextIdx = (meta.chartModes.indexOf(item.chart) + 1) % meta.chartModes.length;
        item.chart = meta.chartModes[nextIdx];
        saveLayoutFor(currentMetrics.mode, layout);
        chartBtn.textContent = CHART_STYLE_LABELS[item.chart] || 'Gráfico';
        if (id === 'chart_gauges') {
          const card = boardEl.querySelector(`article[data-widget-id="chart_gauges"]`);
          const trio = card && card.querySelector('#wb-gauges-trio');
          const meterWrap = card && card.querySelector('#wb-gauges-meter-wrap');
          if (trio && meterWrap) {
            trio.classList.toggle('hidden', item.chart === 'meter');
            meterWrap.classList.toggle('hidden', item.chart !== 'meter');
          }
        }
        patchMonitor(getState());
        requestAnimationFrame(() => patchMonitor(getState()));
      }
      return;
    }

    const remBtn = e.target.closest('button[data-w-remove]');
    if (remBtn) {
      e.stopPropagation();
      toggleWidget(remBtn.dataset.wRemove);
      return;
    }

    if (editMode) {
      if (e.target === boardEl) {
        setEditMode(false);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    const refreshBtn = e.target.closest('button[data-widget-refresh]');
    if (refreshBtn) {
      e.stopPropagation();
      refreshLazyWidget(refreshBtn.dataset.widgetRefresh);
      return;
    }

    const gpuBtn = e.target.closest('button[data-gpu-act]');
    if (gpuBtn) {
      e.stopPropagation();
      try {
        const res = await apiFetch('/api/gpu/action', { method: 'POST', body: { action: gpuBtn.dataset.gpuAct } });
        showToast(res.message || 'Ajuste aplicado!', res.ok ? 'success' : 'error');
        refreshMonitorOnce();
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      return;
    }

    const vmBtn = e.target.closest('button[data-vm-act]');
    if (vmBtn) {
      e.stopPropagation();
      const act = vmBtn.dataset.vmAct;
      const titles = { start: 'Iniciar VM macOS', shutdown: 'Desligar macOS (ACPI)', restart: 'Reiniciar VM macOS' };
      const ok = await confirmAction({
        title: titles[act] || 'Ação da VM',
        message: `Executar "${titles[act] || act}" agora?`,
        confirmLabel: titles[act] || 'Executar',
        danger: act === 'restart',
      });
      if (!ok) return;
      try {
        const res = await apiFetch('/api/vm/action', { method: 'POST', body: { action: act, confirm: true } });
        showToast(res.message || 'Comando enviado à VM.', 'success');
        setTimeout(refreshMonitorOnce, 800);
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      return;
    }

    const hostBtn = e.target.closest('button[data-host-act]');
    if (hostBtn) {
      e.stopPropagation();
      const act = hostBtn.dataset.hostAct;
      const meta = {
        boot_windows: { title: 'Reiniciar no Windows', msg: 'Reiniciar o PC físico direto na partição Windows?', btn: 'Reiniciar no Windows' },
        reboot: { title: 'Reiniciar Host Linux', msg: 'Reiniciar o computador Debian agora?', btn: 'Reiniciar PC' },
        shutdown: { title: 'Desligar Host Linux', msg: 'Desligar o computador Debian agora?', btn: 'Desligar PC' },
      }[act];
      const ok = await confirmAction({
        title: meta ? meta.title : act,
        message: meta ? meta.msg : `Executar ${act} no host?`,
        confirmLabel: meta ? meta.btn : 'Confirmar',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await apiFetch('/api/host/power', { method: 'POST', body: { action: act, confirm: true } });
        showToast(res.message || 'Comando de energia enviado.', 'success', 5500);
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      return;
    }

    const btBtn = e.target.closest('button[data-bt-act]');
    if (btBtn) {
      e.stopPropagation();
      try {
        const res = await apiFetch('/api/usb/bt', { method: 'POST', body: { action: btBtn.dataset.btAct } });
        showToast(res.message || 'Bluetooth atualizado.', 'success');
        refreshLazyWidget('usb_bt');
      } catch (err) {
        showToast(`Erro BT: ${err.message}`, 'error');
      }
      return;
    }

    const pathBtn = e.target.closest('button[data-open-path]');
    if (pathBtn) {
      e.stopPropagation();
      try {
        sessionStorage.setItem('mothos.files.openPath', pathBtn.dataset.openPath);
      } catch {
        // Ignore storage error
      }
      if (onNavigateTab) onNavigateTab('files');
      return;
    }

    const aptBtn = e.target.closest('button[data-apt-check]');
    if (aptBtn) {
      e.stopPropagation();
      try {
        await apiFetch('/api/updates/check', { method: 'POST' });
        showToast('Verificação APT iniciada em segundo plano.', 'info');
        refreshLazyWidget('updates');
      } catch (err) {
        showToast(`Erro APT: ${err.message}`, 'error');
      }
      return;
    }

    const logSrcBtn = e.target.closest('button[data-log-src]');
    if (logSrcBtn) {
      e.stopPropagation();
      logSource = logSrcBtn.dataset.logSrc;
      refreshLazyWidget('logs');
      return;
    }

    const shellChip = e.target.closest('button[data-shell-cmd]');
    if (shellChip) {
      e.stopPropagation();
      runShellCommand(shellChip.dataset.shellCmd);
      return;
    }

    if (e.target.closest('#wb-shell-clear')) {
      e.stopPropagation();
      shellOutput = '';
      syncShellForm();
    }
  }

  boardEl.addEventListener('click', handleBoardClick);

  boardEl.addEventListener('submit', (e) => {
    if (e.target.id === 'wb-shell-form') {
      e.preventDefault();
      e.stopPropagation();
      const input = boardEl.querySelector('#wb-shell-input');
      if (input && input.value.trim()) {
        runShellCommand(input.value);
      }
    }
  });

  if (pickerEl) {
    pickerEl.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('button[data-picker-toggle]');
      if (toggleBtn) {
        toggleWidget(toggleBtn.dataset.pickerToggle);
        return;
      }
      if (e.target.closest('[data-picker-all]')) {
        const m = getGridMetrics();
        const existing = new Set(layout.map((i) => i.id));
        const w = m.mode === 'wide' ? 4 : 6;
        const h = 3;
        for (const meta of WIDGET_CATALOG) {
          if (!existing.has(meta.id)) {
            const spot = findFreeSpotIn(layout, w, h, m.cols);
            layout.push({
              id: meta.id,
              x: spot.x,
              y: spot.y,
              w,
              h,
              z: maxZIndex() + 1,
              chart: meta.defaultChart || null,
            });
          }
        }
        saveLayoutFor(m.mode, layout);
        syncLazyTimer();
        render();
        refreshAllPlacedLazy();
        return;
      }
      if (e.target.closest('[data-picker-pack]')) {
        autoPackLayout();
        showToast('Widgets alinhados sem espaços vazios.', 'info', 2200);
        return;
      }
      if (e.target.closest('[data-picker-reset]')) {
        const m = getGridMetrics();
        layout = defaultLayoutFor(m.mode);
        saveLayoutFor(m.mode, layout);
        syncLazyTimer();
        render();
        refreshAllPlacedLazy();
        return;
      }
      if (e.target.closest('[data-picker-close]')) {
        pickerOpen = false;
        renderPicker();
      }
    });
  }

  if (editBannerEl) {
    editBannerEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-eb-picker]')) {
        pickerOpen = !pickerOpen;
        renderPicker();
      } else if (e.target.closest('[data-eb-pack]')) {
        autoPackLayout();
        showToast('Widgets alinhados sem espaços vazios.', 'info', 2200);
      } else if (e.target.closest('[data-eb-done]')) {
        setEditMode(false);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isActive && editMode) {
      setEditMode(false);
    }
  });

  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      pickerOpen = !pickerOpen;
      renderPicker();
    });
  }

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      setEditMode(!editMode);
    });
  }

  function handleResize() {
    const nextMetrics = getGridMetrics();
    if (nextMetrics.mode !== currentMetrics.mode) {
      currentMetrics = nextMetrics;
      layout = loadLayoutFor(currentMetrics);
      render();
      refreshAllPlacedLazy();
      return;
    }
    positionAllCards();
    patchMonitor(getState());
  }

  return {
    render,
    updateMonitor: patchMonitor,
    handleResize,
    setActive(active) {
      isActive = Boolean(active);
      if (isActive) {
        requestAnimationFrame(() => {
          handleResize();
          refreshAllPlacedLazy();
        });
        syncLazyTimer();
      } else {
        cancelLongPress();
        setEditMode(false);
        clearInterval(lazyTimer);
        lazyTimer = null;
      }
    },
    openPicker() {
      pickerOpen = true;
      renderPicker();
    },
  };
}
