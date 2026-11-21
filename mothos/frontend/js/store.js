/**
 * MothOS Reactive Store + Shared Live Monitor WebSocket (/ws/monitor)
 */

import { apiFetch, buildWsUrl } from './api.js';

const MAX_HISTORY = 60;

const emptyHistory = () => ({
  mhz: [],
  cpuUsage: [],
  temp: [],
  ramPct: [],
  gpuLoad: [],
  gpuFps: [],
  gpuIrq: [],
  gpuVram: [],
});

const state = {
  authenticated: false,
  health: null,
  monitor: null,
  wsStatus: 'offline', // 'offline' | 'connecting' | 'live' | 'reconnecting'
  history: emptyHistory(),
};

const listeners = new Set();
let monitorWs = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let running = false;

function pushSeries(arr, raw) {
  const v = Number(raw);
  if (Number.isFinite(v)) {
    arr.push(v);
    if (arr.length > MAX_HISTORY) arr.shift();
  }
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('Store listener error:', err);
    }
  }
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setHealth(health) {
  state.health = health;
  notify();
}

export function setAuthenticated(isAuth) {
  state.authenticated = Boolean(isAuth);
  if (!state.authenticated) {
    stopMonitorStream();
    state.monitor = null;
    state.history = emptyHistory();
  }
  notify();
}

function ingestSnapshot(data) {
  if (!data || typeof data !== 'object') return;
  state.monitor = data;
  pushSeries(state.history.mhz, data?.cpu?.avg_vcpu_mhz);
  pushSeries(state.history.cpuUsage, data?.cpu?.avg_usage_pct);
  pushSeries(state.history.temp, data?.cpu?.temp_tctl_c);
  const ramTot = Number(data?.memory?.total_mb);
  const ramUsed = Number(data?.memory?.used_mb);
  if (ramTot > 0 && Number.isFinite(ramUsed)) {
    pushSeries(state.history.ramPct, (ramUsed / ramTot) * 100);
  }
  if (data.gpu) {
    pushSeries(state.history.gpuLoad, data.gpu.load_pct);
    pushSeries(state.history.gpuFps, data.gpu.fps);
    pushSeries(state.history.gpuIrq, data.gpu.irq_per_sec);
    pushSeries(state.history.gpuVram, data.gpu.vram_used_mb);
  }
  notify();
}

export async function refreshMonitorOnce() {
  try {
    const snap = await apiFetch('/api/monitor');
    ingestSnapshot(snap);
  } catch {
    // Handled gracefully by WS or auth handler
  }
}

export function startMonitorStream() {
  if (running) return;
  running = true;
  reconnectAttempt = 0;
  refreshMonitorOnce();
  connectWs();
}

function connectWs() {
  if (!running) return;
  clearTimeout(reconnectTimer);

  if (monitorWs) {
    try {
      monitorWs.close();
    } catch {
      // Ignore close error
    }
    monitorWs = null;
  }

  state.wsStatus = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
  notify();

  let ws;
  try {
    ws = new WebSocket(buildWsUrl('/ws/monitor'));
  } catch {
    scheduleReconnect();
    return;
  }
  monitorWs = ws;

  ws.addEventListener('open', () => {
    if (monitorWs !== ws) return;
    reconnectAttempt = 0;
    state.wsStatus = 'live';
    notify();
  });

  ws.addEventListener('message', (event) => {
    if (monitorWs !== ws) return;
    try {
      const payload = JSON.parse(event.data);
      ingestSnapshot(payload);
    } catch {
      // Ignore malformed frame
    }
  });

  ws.addEventListener('close', () => {
    if (monitorWs !== ws) return;
    monitorWs = null;
    if (running) {
      scheduleReconnect();
    } else {
      state.wsStatus = 'offline';
      notify();
    }
  });

  ws.addEventListener('error', () => {
    if (monitorWs !== ws) return;
    try {
      ws.close();
    } catch {
      // Ignore
    }
  });
}

function scheduleReconnect() {
  if (!running) return;
  state.wsStatus = 'reconnecting';
  notify();
  reconnectAttempt += 1;
  const delay = Math.min(8000, 1000 * Math.pow(1.4, Math.min(reconnectAttempt, 6)));
  reconnectTimer = setTimeout(() => {
    if (running) connectWs();
  }, delay);
}

export function stopMonitorStream() {
  running = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (monitorWs) {
    const ws = monitorWs;
    monitorWs = null;
    try {
      ws.close();
    } catch {
      // Ignore
    }
  }
  state.wsStatus = 'offline';
  notify();
}
