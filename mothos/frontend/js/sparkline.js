/**
 * High-DPI Canvas Chart & Radial Gauge Suite (Zero dependencies)
 * Supports 5 live styles: Área (sparkline), Barras (bars), Medidor (gauge), Onda (step), LED (meter)
 * plus per-thread Ryzen Core Equalizer (drawCoreBars).
 */

function prepCanvas(canvas, fallbackW = 260, fallbackH = 64, minW = 64, minH = 36) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(minW, Math.floor(rect.width || canvas.clientWidth || fallbackW));
  const height = Math.max(minH, Math.floor(rect.height || canvas.clientHeight || fallbackH));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawGridLines(ctx, padX, padY, width, plotH, count = 3) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= count; i += 1) {
    const y = padY + (plotH * i) / (count + 1);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
    ctx.stroke();
  }
}

function drawEdgeLabels(ctx, width, height, padX, padY, options) {
  if (!options.maxLabel && !options.minLabel) return;
  ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
  ctx.textAlign = 'right';
  if (options.maxLabel) ctx.fillText(options.maxLabel, width - padX - 2, padY + 9);
  if (options.minLabel) ctx.fillText(options.minLabel, width - padX - 2, height - padY - 2);
}

function computeSeriesRange(series, values) {
  let min = series.min !== undefined ? series.min : Math.min(...values);
  let max = series.max !== undefined ? series.max : Math.max(...values);
  if (max - min < 1e-3) {
    min -= 1;
    max += 1;
  }
  return { min, max };
}

export function drawSparkline(canvas, seriesList, options = {}) {
  const surf = prepCanvas(canvas, 260, 64, 100, 36);
  if (!surf) return;
  const { ctx, width, height } = surf;

  const padX = options.padX ?? 4;
  const padY = options.padY ?? 6;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  if (options.grid) drawGridLines(ctx, padX, padY, width, plotH, 3);

  for (const series of seriesList) {
    const values = (series.values || []).filter((v) => Number.isFinite(v));
    if (values.length < 2) continue;

    const { min, max } = computeSeriesRange(series, values);
    const stepX = plotW / Math.max(1, values.length - 1);
    const points = values.map((v, idx) => {
      const x = padX + idx * stepX;
      const norm = (v - min) / (max - min);
      const y = padY + plotH - Math.max(0, Math.min(1, norm)) * plotH;
      return { x, y };
    });

    if (series.fill) {
      const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
      grad.addColorStop(0, series.fillTop || 'rgba(56, 189, 248, 0.30)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

      ctx.beginPath();
      ctx.moveTo(points[0].x, height - padY);
      for (let i = 0; i < points.length; i += 1) {
        if (i === 0) {
          ctx.lineTo(points[i].x, points[i].y);
        } else {
          const prev = points[i - 1];
          const midX = (prev.x + points[i].x) / 2;
          ctx.quadraticCurveTo(prev.x, prev.y, midX, (prev.y + points[i].y) / 2);
          if (i === points.length - 1) ctx.lineTo(points[i].x, points[i].y);
        }
      }
      ctx.lineTo(points[points.length - 1].x, height - padY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const midX = (prev.x + points[i].x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, midX, (prev.y + points[i].y) / 2);
      if (i === points.length - 1) ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = series.stroke || '#38bdf8';
    ctx.lineWidth = series.lineWidth || 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = series.stroke || '#38bdf8';
    ctx.fill();
  }

  drawEdgeLabels(ctx, width, height, padX, padY, options);
  ctx.restore();
}

export function drawBarChart(canvas, series, options = {}) {
  const surf = prepCanvas(canvas, 260, 64, 100, 36);
  if (!surf) return;
  const { ctx, width, height } = surf;

  const padX = options.padX ?? 4;
  const padY = options.padY ?? 6;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  if (options.grid !== false) drawGridLines(ctx, padX, padY, width, plotH, 2);

  const raw = (series?.values || []).filter((v) => Number.isFinite(v));
  const maxBars = Math.max(16, Math.min(48, Math.floor(plotW / 6)));
  const values = raw.slice(-maxBars);

  if (values.length > 0) {
    const { min, max } = computeSeriesRange(series || {}, values);
    const slotW = plotW / values.length;
    const gap = Math.max(1.5, Math.min(4, slotW * 0.25));
    const barW = Math.max(2, slotW - gap);
    const color = (series && series.stroke) || '#38bdf8';

    for (let i = 0; i < values.length; i += 1) {
      const norm = Math.max(0.06, Math.min(1, (values[i] - min) / (max - min)));
      const bh = Math.max(3, norm * plotH);
      const x = padX + i * slotW + gap * 0.5;
      const y = padY + plotH - bh;
      const isLast = i === values.length - 1;

      const grad = ctx.createLinearGradient(0, y, 0, padY + plotH);
      grad.addColorStop(0, color);
      grad.addColorStop(1, (series && series.fillTop) || 'rgba(56, 189, 248, 0.14)');
      ctx.globalAlpha = isLast ? 1 : 0.72 + (i / values.length) * 0.24;
      ctx.fillStyle = grad;

      const r = Math.min(3, barW / 2, bh / 2);
      ctx.beginPath();
      ctx.roundRect(x, y, barW, bh, [r, r, 1, 1]);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawEdgeLabels(ctx, width, height, padX, padY, options);
  ctx.restore();
}

export function drawStepChart(canvas, seriesList, options = {}) {
  const surf = prepCanvas(canvas, 260, 64, 100, 36);
  if (!surf) return;
  const { ctx, width, height } = surf;

  const padX = options.padX ?? 4;
  const padY = options.padY ?? 6;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  // Faint oscilloscope grid
  drawGridLines(ctx, padX, padY, width, plotH, 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 5; i += 1) {
    const x = padX + (plotW * i) / 6;
    ctx.beginPath();
    ctx.moveTo(x, padY);
    ctx.lineTo(x, height - padY);
    ctx.stroke();
  }

  for (const series of seriesList) {
    const values = (series.values || []).filter((v) => Number.isFinite(v));
    if (values.length < 2) continue;

    const { min, max } = computeSeriesRange(series, values);
    const stepX = plotW / Math.max(1, values.length - 1);
    const points = values.map((v, idx) => {
      const x = padX + idx * stepX;
      const norm = (v - min) / (max - min);
      const y = padY + plotH - Math.max(0, Math.min(1, norm)) * plotH;
      return { x, y };
    });

    if (series.fill) {
      const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
      grad.addColorStop(0, series.fillTop || 'rgba(52, 211, 153, 0.28)');
      grad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');
      ctx.beginPath();
      ctx.moveTo(points[0].x, height - padY);
      ctx.lineTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i - 1].y);
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.lineTo(points[points.length - 1].x, height - padY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = series.stroke || '#34d399';
    ctx.lineWidth = series.lineWidth || 2;
    ctx.stroke();

    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = series.stroke || '#34d399';
    ctx.fill();
  }

  drawEdgeLabels(ctx, width, height, padX, padY, options);
  ctx.restore();
}

export function drawSegmentedMeter(canvas, rows = [], options = {}) {
  const surf = prepCanvas(canvas, 260, 72, 100, 40);
  if (!surf) return;
  const { ctx, width, height } = surf;

  const list = Array.isArray(rows) ? rows.slice(0, 3) : [];
  if (list.length === 0) {
    ctx.restore();
    return;
  }

  const padX = options.padX ?? 4;
  const padY = options.padY ?? 4;
  const rowCount = list.length;
  const rowGap = rowCount > 1 ? 6 : 0;
  const rowH = (height - padY * 2 - rowGap * (rowCount - 1)) / rowCount;
  const segCount = Math.max(14, Math.min(26, Math.floor((width - padX * 2) / 10)));
  const segGap = 2.5;

  for (let rIdx = 0; rIdx < rowCount; rIdx += 1) {
    const row = list[rIdx];
    const ry = padY + rIdx * (rowH + rowGap);
    const labelH = Math.min(13, Math.max(10, rowH * 0.36));
    const barY = ry + labelH + 2;
    const barH = Math.max(7, rowH - labelH - 3);
    const pct = Math.max(0, Math.min(100, Number(row.pct) || 0));
    const activeCount = Math.round((pct / 100) * segCount);
    const color = row.color || '#38bdf8';

    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(203, 213, 225, 0.88)';
    ctx.textAlign = 'left';
    ctx.fillText(String(row.label || ''), padX, ry + labelH - 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(String(row.valueText || `${Math.round(pct)}%`), width - padX, ry + labelH - 2);

    const totalW = width - padX * 2;
    const segW = Math.max(2, (totalW - segGap * (segCount - 1)) / segCount);

    for (let s = 0; s < segCount; s += 1) {
      const sx = padX + s * (segW + segGap);
      const lit = s < activeCount;
      ctx.fillStyle = lit ? color : 'rgba(255, 255, 255, 0.08)';
      ctx.globalAlpha = lit ? 0.92 : 1;
      ctx.beginPath();
      ctx.roundRect(sx, barY, segW, barH, 2.5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

export function drawCoreBars(canvas, cores = [], options = {}) {
  const surf = prepCanvas(canvas, 280, 96, 120, 48);
  if (!surf) return;
  const { ctx, width, height } = surf;

  const list = Array.isArray(cores) ? cores : [];
  if (list.length === 0) {
    ctx.restore();
    return;
  }

  const style = options.style === 'meter' ? 'meter' : 'bars';
  const padX = 4;
  const padTop = 6;
  const labelBand = 13;
  const plotW = width - padX * 2;
  const plotH = Math.max(22, height - padTop - labelBand - 4);
  const slotW = plotW / list.length;
  const gap = Math.max(2, Math.min(5, slotW * 0.24));
  const barW = Math.max(3, slotW - gap);

  drawGridLines(ctx, padX, padTop, width, plotH, 2);

  const ledRows = 10;
  const ledGap = 2;
  const ledH = Math.max(2, (plotH - ledGap * (ledRows - 1)) / ledRows);

  for (let i = 0; i < list.length; i += 1) {
    const core = list[i];
    const isVcpu = String(core.role || '').toLowerCase() === 'vcpu';
    const color = isVcpu ? '#38bdf8' : '#fbbf24';
    const usage = Math.max(0, Math.min(100, Number(core.usage_pct) || 0));
    const x = padX + i * slotW + gap * 0.5;

    if (style === 'meter') {
      const litCells = Math.max(usage > 2 ? 1 : 0, Math.round((usage / 100) * ledRows));
      for (let r = 0; r < ledRows; r += 1) {
        const y = padTop + plotH - (r + 1) * ledH - r * ledGap;
        ctx.fillStyle = r < litCells ? color : 'rgba(255, 255, 255, 0.08)';
        ctx.beginPath();
        ctx.roundRect(x, y, barW, ledH, 2);
        ctx.fill();
      }
    } else {
      const norm = Math.max(0.05, usage / 100);
      const bh = Math.max(3, norm * plotH);
      const y = padTop + plotH - bh;
      const grad = ctx.createLinearGradient(0, y, 0, padTop + plotH);
      grad.addColorStop(0, color);
      grad.addColorStop(1, isVcpu ? 'rgba(56, 189, 248, 0.16)' : 'rgba(251, 191, 36, 0.16)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, bh, [Math.min(3, barW / 2), Math.min(3, barW / 2), 1, 1]);
      ctx.fill();
    }

    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = isVcpu ? 'rgba(125, 211, 252, 0.85)' : 'rgba(253, 230, 138, 0.85)';
    ctx.textAlign = 'center';
    ctx.fillText(String(core.id ?? i), x + barW / 2, height - 3);
  }

  ctx.restore();
}

export function drawGaugeRing(canvas, pct, color = '#38bdf8', label = '', sublabel = '', options = {}) {
  const fit = Boolean(options && options.fit);
  const surf = fit
    ? prepCanvas(canvas, 110, 84, 52, 52)
    : (() => {
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const rect = canvas.getBoundingClientRect();
        const size = Math.max(88, Math.min(140, Math.floor(rect.width || canvas.clientWidth || 104)));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
          canvas.width = size * dpr;
          canvas.height = size * dpr;
        }
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, size, size);
        return { ctx, width: size, height: size };
      })();

  if (!surf) return;
  const { ctx, width, height } = surf;
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2 + size * 0.04;
  const strokeW = fit ? Math.max(4.5, Math.min(9, size * 0.088)) : 8;
  const r = Math.max(16, size / 2 - strokeW - (fit ? 2 : 1));
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const norm = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));

  ctx.lineCap = 'round';
  ctx.lineWidth = strokeW;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + sweep);
  ctx.stroke();

  if (norm > 0.005) {
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = fit ? 8 : 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep * norm);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const mainFontPx = fit ? Math.max(12, Math.min(20, Math.round(size * 0.18))) : 17;
  const subFontPx = fit ? Math.max(8.5, Math.min(11, Math.round(size * 0.11))) : 10;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `700 ${mainFontPx}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillText(label || `${Math.round(norm * 100)}%`, cx, sublabel ? cy + 1 : cy + mainFontPx * 0.34);

  if (sublabel) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.88)';
    ctx.font = `600 ${subFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(sublabel, cx, cy + mainFontPx * 0.95);
  }

  ctx.restore();
}

export function drawChartVariant(canvas, style, config) {
  if (!canvas || !config) return;
  const mode = style || 'area';
  if (mode === 'bars') {
    const primary = (config.series && config.series[0]) || {};
    drawBarChart(canvas, primary, config.options || {});
  } else if (mode === 'step') {
    drawStepChart(canvas, config.series || [], config.options || {});
  } else if (mode === 'gauge') {
    const g = config.gauge || {};
    drawGaugeRing(canvas, g.pct ?? 0, g.color || '#38bdf8', g.label || '', g.sublabel || '', { fit: true });
  } else if (mode === 'meter') {
    drawSegmentedMeter(canvas, config.meterRows || [], config.options || {});
  } else {
    drawSparkline(canvas, config.series || [], config.options || {});
  }
}
