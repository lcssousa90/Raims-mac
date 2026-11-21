/**
 * MothOS utility functions (XSS-safe escaping, formatting, ANSI sanitizing)
 */

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatMb(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  return `${Math.round(n)} MB`;
}

export function formatMhz(mhz) {
  const n = Number(mhz);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)} MHz`;
}

export function formatTemp(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return '— °C';
  return `${n.toFixed(1)} °C`;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function formatTimestamp(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n * 1000);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isExecutableUpload(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return (
    lower.endsWith('.deb') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  );
}

export function joinPath(dir, name) {
  const cleanDir = dir === '/' ? '' : String(dir || '').replace(/\/+$/, '');
  const cleanName = String(name || '').replace(/^\/+/, '');
  return `${cleanDir}/${cleanName}` || '/';
}

/**
 * Strip ANSI CSI/OSC escape sequences for safe plain-text rendering
 */
export function stripAnsi(text) {
  if (!text) return '';
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r(?!\n)/g, '');
}

/**
 * Classify a log line for visual severity highlighting
 */
export function classifyLogLine(line) {
  const l = String(line || '').toLowerCase();
  if (/(error|failed|fatal|panic|crit|segfault|denied|traceback|exception|\berr\b)/i.test(l)) {
    return 'log-err';
  }
  if (/(warn|warning|timeout|deprecated|retry|leak|libusb)/i.test(l)) {
    return 'log-warn';
  }
  if (/(started|ready|listening|connected|attached|ok\b|success)/i.test(l)) {
    return 'log-ok';
  }
  return '';
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
