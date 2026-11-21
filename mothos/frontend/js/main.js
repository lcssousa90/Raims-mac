/**
 * MothOS Main Entry Point — Lock Screen, Top-Level Tab Shell, Custom Widget Board & PWA Install
 */

import { apiFetch, setToken, clearToken, setUnauthorizedHandler } from './api.js';
import {
  getState,
  subscribe,
  setHealth,
  setAuthenticated,
  startMonitorStream,
  stopMonitorStream,
} from './store.js';
import { Icons, showToast } from './ui.js';
import { esc, formatUptime } from './utils.js';
import { createWidgetBoard } from './widgets.js';

import { mountGpuApp } from './apps/gpu.js';
import { mountMonitorApp } from './apps/monitor.js';
import { mountVmApp } from './apps/vm.js';
import { mountUsbApp } from './apps/usb.js';
import { mountFilesApp } from './apps/files.js';
import { mountUpdatesApp } from './apps/updates.js';
import { mountTerminalApp } from './apps/terminal.js';

const TABS = [
  {
    id: 'home',
    label: 'Início',
    title: 'Painel do Sistema',
    subtitle: 'Resumo ao vivo do host & VM',
    icon: Icons.home,
    gradient: 'icon-grad-cyan',
    mount: null,
  },
  {
    id: 'gpu',
    label: 'GPU',
    title: 'GPU & Tuning',
    subtitle: 'RTX 3070, PCIe & NullMoth 3.0',
    icon: Icons.gpu,
    gradient: 'icon-grad-emerald',
    mount: mountGpuApp,
  },
  {
    id: 'monitor',
    label: 'Monitor',
    title: 'Monitor do Host',
    subtitle: 'Ryzen 5600X, RAM, Discos & IRQs',
    icon: Icons.monitor,
    gradient: 'icon-grad-cyan',
    mount: mountMonitorApp,
  },
  {
    id: 'vm',
    label: 'VM & Boot',
    title: 'VM & Dual-Boot',
    subtitle: 'macOS VFIO, Windows & Energia',
    icon: Icons.vm,
    gradient: 'icon-grad-indigo',
    mount: mountVmApp,
  },
  {
    id: 'usb',
    label: 'USB & BT',
    title: 'USB & Bluetooth',
    subtitle: 'AX200 Guard & Hot-Plug QMP',
    icon: Icons.usb,
    gradient: 'icon-grad-blue',
    mount: mountUsbApp,
  },
  {
    id: 'files',
    label: 'Arquivos',
    title: 'Arquivos',
    subtitle: 'Finder completo (/) & Editor',
    icon: Icons.files,
    gradient: 'icon-grad-sky',
    mount: mountFilesApp,
  },
  {
    id: 'updates',
    label: 'Updates',
    title: 'Atualizações & Serviços',
    subtitle: 'APT & Systemd',
    icon: Icons.updates,
    gradient: 'icon-grad-amber',
    mount: mountUpdatesApp,
  },
  {
    id: 'terminal',
    label: 'Logs & Shell',
    title: 'Logs & Shell',
    subtitle: 'Logs ao Vivo & Console PTY',
    icon: Icons.terminal,
    gradient: 'icon-grad-violet',
    mount: mountTerminalApp,
  },
];

// DOM Refs
const lockScreen = document.getElementById('lock-screen');
const lockCard = document.getElementById('lock-card');
const lockSubtitle = document.getElementById('lock-subtitle');
const pinDotsEl = document.getElementById('pin-dots');
const pinErrorEl = document.getElementById('pin-error');
const pinKeypad = document.getElementById('pin-keypad');
const pinSubmitBtn = document.getElementById('pin-submit-btn');

const osShell = document.getElementById('os-shell');
const statusHostname = document.getElementById('status-hostname');
const statusVmPill = document.getElementById('status-vm-pill');
const statusWsPill = document.getElementById('status-ws-pill');
const lockBtn = document.getElementById('lock-btn');
const homeBrandBtn = document.getElementById('home-brand-btn');
const homeMeta = document.getElementById('home-meta');
const devModeBadge = document.getElementById('dev-mode-badge');
const osTabs = document.getElementById('os-tabs');

// Home Widget Board & Picker Refs
const widgetBoardEl = document.getElementById('widget-board');
const widgetPickerEl = document.getElementById('widget-picker-panel');
const widgetsManageBtn = document.getElementById('widgets-manage-btn');
const widgetsEditBtn = document.getElementById('widgets-edit-btn');

// PWA Install Assistant Refs
const pwaInstallBtn = document.getElementById('pwa-install-btn');
const pwaInstallIcon = document.getElementById('pwa-install-icon');
const pwaInstallLabel = document.getElementById('pwa-install-label');
const pwaInstallPanel = document.getElementById('pwa-install-panel');
const pwaCheckHttps = document.getElementById('pwa-check-https');
const pwaCheckSw = document.getElementById('pwa-check-sw');
const pwaCheckPrompt = document.getElementById('pwa-check-prompt');
const pwaNativeRow = document.getElementById('pwa-native-row');
const pwaTriggerNativeBtn = document.getElementById('pwa-trigger-native-btn');
const pwaHttpsUrl = document.getElementById('pwa-https-url');
const pwaOpenHttpsBtn = document.getElementById('pwa-open-https-btn');
const pwaCopyOriginBtn = document.getElementById('pwa-copy-origin-btn');
const pwaPanelCloseBtn = document.getElementById('pwa-panel-close-btn');

// Tab Panel Refs
const tabPanelHome = document.getElementById('tab-panel-home');
const tabPanelApp = document.getElementById('tab-panel-app');
const tabPageIcon = document.getElementById('tab-page-icon');
const tabPageTitle = document.getElementById('tab-page-title');
const tabPageSubtitle = document.getElementById('tab-page-subtitle');
const tabAppBody = document.getElementById('tab-app-body');

let pinBuffer = '';
let pinSubmitting = false;
let activeTabId = 'home';
let activeTabCleanup = null;
let deferredInstallPrompt = null;
let swRegistered = false;

const widgetBoard = createWidgetBoard({
  boardEl: widgetBoardEl,
  pickerEl: widgetPickerEl,
  manageBtn: widgetsManageBtn,
  editBtn: widgetsEditBtn,
  onNavigateTab: (id) => switchTab(id),
});

// --- SERVICE WORKER ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => {
        swRegistered = true;
        updatePwaStatus();
      })
      .catch(() => {});
  });
}

// --- LOCK SCREEN / PIN PAD ---

function renderPinDots() {
  const count = Math.max(4, pinBuffer.length);
  pinDotsEl.innerHTML = Array.from({ length: count }, (_, idx) => {
    const filled = idx < pinBuffer.length;
    return `<span class="pin-dot ${filled ? 'filled' : ''}"></span>`;
  }).join('');
}

function triggerPinShake(message) {
  pinErrorEl.textContent = message;
  lockCard.classList.remove('shake');
  // Force reflow to restart animation
  void lockCard.offsetWidth;
  lockCard.classList.add('shake');
}

function pushPinDigit(digit) {
  if (pinSubmitting || pinBuffer.length >= 12) return;
  pinErrorEl.textContent = '';
  pinBuffer += digit;
  renderPinDots();
  if (pinBuffer.length === 4) {
    submitPin(true);
  }
}

function backspacePin() {
  if (pinSubmitting || !pinBuffer.length) return;
  pinBuffer = pinBuffer.slice(0, -1);
  pinErrorEl.textContent = '';
  renderPinDots();
}

function clearPin() {
  if (pinSubmitting) return;
  pinBuffer = '';
  pinErrorEl.textContent = '';
  renderPinDots();
}

async function submitPin(isAuto4 = false) {
  if (pinSubmitting || !pinBuffer.length) return;
  pinSubmitting = true;
  pinSubmitBtn.disabled = true;
  pinSubmitBtn.textContent = 'Verificando...';

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { pin: pinBuffer },
      skipAuthRedirect: true,
    });
    if (res && res.token) {
      setToken(res.token);
    }
    pinBuffer = '';
    pinErrorEl.textContent = '';
    renderPinDots();
    enterShell();
    showToast('Bem-vindo ao MothOS', 'success', 2400);
  } catch (err) {
    if (err.status === 401) {
      triggerPinShake('PIN incorreto. Tente novamente.');
      if (isAuto4) {
        pinBuffer = '';
        renderPinDots();
      }
    } else {
      triggerPinShake(err.message || 'Erro ao conectar com o host.');
    }
  } finally {
    pinSubmitting = false;
    pinSubmitBtn.disabled = false;
    pinSubmitBtn.textContent = 'Desbloquear';
  }
}

pinKeypad.addEventListener('click', (e) => {
  const btn = e.target.closest('.pin-key');
  if (!btn) return;
  if (btn.dataset.digit !== undefined) {
    pushPinDigit(btn.dataset.digit);
  } else if (btn.dataset.action === 'backspace') {
    backspacePin();
  } else if (btn.dataset.action === 'clear') {
    clearPin();
  }
});

pinSubmitBtn.addEventListener('click', () => submitPin(false));

document.addEventListener('keydown', (e) => {
  const st = getState();
  if (!st.authenticated && !lockScreen.classList.contains('hidden')) {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pushPinDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      backspacePin();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitPin(false);
    } else if (e.key === 'Escape') {
      clearPin();
    }
    return;
  }

  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open-tab][role="button"]')) {
    e.preventDefault();
    switchTab(e.target.dataset.openTab);
  }
});

// --- SHELL TRANSITIONS ---

function showLockScreen(reason = '') {
  widgetBoard.setActive(false);
  if (activeTabCleanup) {
    try {
      activeTabCleanup();
    } catch {
      // Ignore cleanup error
    }
    activeTabCleanup = null;
  }
  tabAppBody.innerHTML = '';
  tabPanelApp.classList.add('hidden');
  tabPanelHome.classList.remove('hidden');
  activeTabId = 'home';
  syncTabBarUI('home', false);
  stopMonitorStream();
  setAuthenticated(false);
  osShell.classList.add('hidden');
  lockScreen.classList.remove('hidden');
  pinBuffer = '';
  renderPinDots();
  pinErrorEl.textContent = reason;
}

function enterShell() {
  setAuthenticated(true);
  lockScreen.classList.add('hidden');
  osShell.classList.remove('hidden');
  startMonitorStream();
  switchTab(getHashTab(), { updateHash: true, replaceHash: true, force: true });
}

async function handleLogout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
  } catch {
    // Proceed to lock locally even if host is unreachable
  }
  clearToken();
  showLockScreen();
  showToast('Sessão bloqueada.', 'info', 2200);
}

setUnauthorizedHandler(() => {
  showLockScreen('Sessão expirada. Digite o PIN novamente.');
});

lockBtn.addEventListener('click', handleLogout);
homeBrandBtn.addEventListener('click', () => switchTab('home'));

// --- TOP-LEVEL TAB BAR & ROUTER ---

function renderTabBar() {
  if (!osTabs) return;
  osTabs.innerHTML = TABS.map(
    (tab) => `
    <button type="button" class="os-tab ${activeTabId === tab.id ? 'active' : ''}" role="tab" aria-selected="${activeTabId === tab.id ? 'true' : 'false'}" data-tab-target="${esc(tab.id)}">
      <span class="os-tab-icon">${tab.icon}</span>
      <span class="os-tab-label">${esc(tab.label)}</span>
    </button>
  `
  ).join('');
}

function syncTabBarUI(tabId, scroll = true) {
  if (!osTabs) return;
  let activeBtn = null;
  osTabs.querySelectorAll('.os-tab').forEach((btn) => {
    const isCurrent = btn.dataset.tabTarget === tabId;
    btn.classList.toggle('active', isCurrent);
    btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    if (isCurrent) activeBtn = btn;
  });
  if (scroll && activeBtn && typeof activeBtn.scrollIntoView === 'function') {
    activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

function getHashTab() {
  const hashId = window.location.hash.replace(/^#/, '');
  return TABS.some((t) => t.id === hashId) ? hashId : 'home';
}

function switchTab(tabId, { updateHash = true, replaceHash = false, force = false } = {}) {
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  if (!force && activeTabId === tab.id && (tab.id === 'home' || activeTabCleanup !== null)) {
    return;
  }

  if (activeTabCleanup) {
    try {
      activeTabCleanup();
    } catch {
      // Ignore cleanup error
    }
    activeTabCleanup = null;
  }

  activeTabId = tab.id;
  syncTabBarUI(tab.id);

  if (updateHash) {
    const targetHash = `#${tab.id}`;
    if (window.location.hash !== targetHash) {
      if (replaceHash) {
        history.replaceState({ tab: tab.id }, '', targetHash);
      } else {
        history.pushState({ tab: tab.id }, '', targetHash);
      }
    }
  }

  if (tab.id === 'home') {
    tabAppBody.innerHTML = '';
    tabPanelApp.classList.add('hidden');
    tabPanelHome.classList.remove('hidden');
    window.scrollTo(0, 0);
    widgetBoard.setActive(true);
    updateHomeView(getState());
    requestAnimationFrame(() => updateHomeView(getState()));
    return;
  }

  widgetBoard.setActive(false);
  tabPanelHome.classList.add('hidden');
  tabPageIcon.className = `tab-page-icon ${tab.gradient}`;
  tabPageIcon.innerHTML = tab.icon;
  tabPageTitle.textContent = tab.title;
  tabPageSubtitle.textContent = tab.subtitle;
  tabAppBody.innerHTML = '';
  // Unhide panel before mounting so canvases read real dimensions on first paint
  tabPanelApp.classList.remove('hidden');
  activeTabCleanup = tab.mount(tabAppBody) || null;
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  if (!getState().authenticated) return;
  const tabBtn = e.target.closest('button[data-tab-target]');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tabTarget);
    return;
  }
  const opener = e.target.closest('[data-open-tab]');
  if (opener) {
    switchTab(opener.dataset.openTab);
  }
});

window.addEventListener('popstate', () => {
  if (getState().authenticated) {
    switchTab(getHashTab(), { updateHash: false });
  }
});

window.addEventListener('hashchange', () => {
  if (getState().authenticated) {
    switchTab(getHashTab(), { updateHash: false });
  }
});

// --- ANDROID CHROME PWA INSTALL ASSISTANT ---

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function getHttpsTargetUrl() {
  const health = getState().health;
  const ports = health && Array.isArray(health.https_ports) ? health.https_ports : [];
  const host = window.location.hostname || '192.168.18.10';
  if (ports.includes(443) || window.location.protocol === 'https:') {
    const portPart = window.location.protocol === 'https:' && window.location.port ? `:${window.location.port}` : '';
    return `https://${host}${portPart}/#home`;
  }
  const alt = ports[0] || 8443;
  return `https://${host}:${alt}/#home`;
}

function updatePwaStatus() {
  if (!pwaInstallBtn) return;
  const standalone = isStandalone();
  if (standalone) {
    pwaInstallBtn.classList.add('hidden');
    if (pwaInstallPanel) pwaInstallPanel.classList.add('hidden');
    return;
  }

  pwaInstallBtn.classList.remove('hidden');
  if (pwaInstallLabel) {
    pwaInstallLabel.textContent = deferredInstallPrompt ? 'Instalar App' : 'Instalar';
  }
  if (pwaNativeRow) {
    pwaNativeRow.classList.toggle('hidden', !deferredInstallPrompt);
  }

  const isHttps = window.location.protocol === 'https:' || window.isSecureContext;
  const hasSwCtrl = swRegistered || Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);

  if (pwaCheckHttps) {
    pwaCheckHttps.className = `pill pill-xs ${isHttps ? 'pill-green' : 'pill-amber'}`;
    pwaCheckHttps.textContent = isHttps ? 'HTTPS: OK' : 'HTTPS: HTTP';
  }
  if (pwaCheckSw) {
    pwaCheckSw.className = `pill pill-xs ${hasSwCtrl ? 'pill-green' : 'pill-muted'}`;
    pwaCheckSw.textContent = hasSwCtrl ? 'SW: Ativo' : 'SW: Aguard.';
  }
  if (pwaCheckPrompt) {
    pwaCheckPrompt.className = `pill pill-xs ${deferredInstallPrompt ? 'pill-green' : 'pill-muted'}`;
    pwaCheckPrompt.textContent = deferredInstallPrompt ? 'Prompt: Pronto' : 'Prompt: Manual/CA';
  }

  const targetHttps = getHttpsTargetUrl();
  if (pwaHttpsUrl) pwaHttpsUrl.textContent = targetHttps.replace(/#home$/, '');
  if (pwaOpenHttpsBtn) pwaOpenHttpsBtn.href = targetHttps;
}

async function triggerNativeInstall() {
  if (!deferredInstallPrompt) return false;
  try {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updatePwaStatus();
    if (choice && choice.outcome === 'accepted') {
      if (pwaInstallPanel) pwaInstallPanel.classList.add('hidden');
      showToast('Instalação do MothOS confirmada!', 'success', 3500);
    }
    return true;
  } catch {
    return false;
  }
}

function initPwaInstall() {
  if (pwaInstallIcon) pwaInstallIcon.innerHTML = Icons.smartphone;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updatePwaStatus();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updatePwaStatus();
    showToast('MothOS instalado no Android!', 'success', 4000);
  });

  if (pwaInstallBtn) {
    pwaInstallBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        await triggerNativeInstall();
        return;
      }
      if (pwaInstallPanel) {
        pwaInstallPanel.classList.toggle('hidden');
        updatePwaStatus();
      }
    });
  }

  if (pwaTriggerNativeBtn) {
    pwaTriggerNativeBtn.addEventListener('click', triggerNativeInstall);
  }

  if (pwaPanelCloseBtn && pwaInstallPanel) {
    pwaPanelCloseBtn.addEventListener('click', () => pwaInstallPanel.classList.add('hidden'));
  }

  if (pwaCopyOriginBtn) {
    pwaCopyOriginBtn.addEventListener('click', async () => {
      const origin = window.location.origin;
      try {
        await navigator.clipboard.writeText(origin);
        showToast(`Copiado: ${origin}`, 'success');
      } catch {
        showToast(`Origem HTTP: ${origin}`, 'info', 4500);
      }
    });
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) {
        swRegistered = true;
        updatePwaStatus();
      }
    }).catch(() => {});
  }

  updatePwaStatus();
}

// --- LIVE HOME STATUS & WIDGET SYNC ---

function updateHomeView(st) {
  if (st.health) {
    devModeBadge.classList.toggle('hidden', !st.health.dev_mode);
    lockSubtitle.textContent = st.health.dev_mode
      ? 'Modo de Desenvolvimento • Digite o PIN'
      : 'Digite o PIN de acesso';
    updatePwaStatus();
  }

  // WS status pill in top status bar
  const wsClasses = {
    live: 'pill-green',
    connecting: 'pill-amber',
    reconnecting: 'pill-amber',
    offline: 'pill-rose',
  };
  const wsLabels = {
    live: 'Ao Vivo',
    connecting: 'WS...',
    reconnecting: 'Reconn',
    offline: 'Offline',
  };
  statusWsPill.className = `pill pill-ws ${wsClasses[st.wsStatus] || 'pill-muted'}`;
  statusWsPill.querySelector('.pill-text').textContent = wsLabels[st.wsStatus] || 'WS';

  const data = st.monitor;
  if (!data) return;

  const vm = data.vm || {};

  // Top Status Bar
  statusHostname.textContent = data.hostname || 'host';
  const vmRunning = Boolean(vm.running);
  statusVmPill.className = `pill ${vmRunning ? 'pill-green' : 'pill-muted'}`;
  statusVmPill.querySelector('.pill-text').textContent = vmRunning ? 'VM Online' : 'VM Offline';

  const load = Array.isArray(data.load_avg) ? data.load_avg.map((v) => Number(v).toFixed(2)).join(' ') : '—';
  homeMeta.textContent = `${data.hostname || 'debian'} • Uptime ${formatUptime(data.uptime_s)} • Load ${load}`;

  if (activeTabId === 'home') {
    widgetBoard.updateMonitor(st);
  }
}

subscribe(updateHomeView);
window.addEventListener('resize', () => {
  if (activeTabId === 'home') {
    widgetBoard.handleResize();
    updateHomeView(getState());
  }
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (activeTabId === 'home') {
      widgetBoard.handleResize();
      updateHomeView(getState());
    }
  }, 150);
});

// --- BOOTSTRAP ---

async function init() {
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch {
    // Ignore when unsupported or not fullscreen
  }

  renderTabBar();
  widgetBoard.render();
  renderPinDots();
  initPwaInstall();

  try {
    const health = await apiFetch('/api/health', { skipAuthRedirect: true });
    setHealth(health);
  } catch {
    // Host health check optional on offline start
  }

  try {
    const me = await apiFetch('/api/auth/me', { skipAuthRedirect: true });
    if (me && me.authenticated) {
      enterShell();
      return;
    }
  } catch {
    // Fall through to Lock Screen
  }

  showLockScreen();
}

init();
