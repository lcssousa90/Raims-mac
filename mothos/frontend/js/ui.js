/**
 * MothOS UI Primitives: Inline SVG Icons, Toast Notifications,
 * 2-Step Confirmation Modal, and Glass Input Prompt Modal.
 */

import { esc } from './utils.js';

export const Icons = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4.5v-6h3v6H18a1 1 0 0 0 1-1V9.5"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  smartphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M12 18h.01"/></svg>`,
  gpu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2.5"/><circle cx="9" cy="11" r="2.6"/><circle cx="15.5" cy="11" r="2"/><path d="M7 17v3M12 17v3M17 17v3"/><path d="M1 9h2M1 13h2"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/></svg>`,
  monitor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  vm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="M9.5 10l2 2 3.5-4"/></svg>`,
  usb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v15"/><path d="M9 5l3-3 3 3"/><circle cx="12" cy="19" r="2.2"/><path d="M12 14l-5-3V8"/><rect x="5.5" y="6" width="3" height="3" rx="0.6"/><path d="M12 12l5-3V7"/><circle cx="17" cy="6.5" r="1.5"/></svg>`,
  files: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>`,
  updates: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><polyline points="7 10 10.5 13 7 16"/><line x1="12.5" y1="16" x2="17" y2="16"/></svg>`,
  windows: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.5L10.6 4.4V11.6H3V5.5ZM11.6 4.3L21 3V11.6H11.6V4.3ZM3 12.6H10.6V19.7L3 18.6V12.6ZM11.6 12.6H21V21L11.6 19.8V12.6Z"/></svg>`,
  power: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/></svg>`,
  reboot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>`,
  bluetooth: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 22 12 2 17.5 6.5 6.5 17.5"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><polyline points="14 2 14 7 19 7"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  pkg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4.5v11L12 22l-8-4.5v-11z"/><path d="M12 22V11.5"/><path d="M20 6.5L12 11.5 4 6.5"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
  save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
};

export function showToast(message, type = 'info', duration = 3600) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-dot"></span>
    <span class="toast-msg">${esc(message)}</span>
  `;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  const remove = () => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 260);
  };

  toast.addEventListener('click', remove);
  setTimeout(remove, duration);
}

/**
 * Sleek 2-Step Confirmation Modal for destructive or critical actions.
 * Step 1: Review details -> click "Continuar"
 * Step 2: Final safeguard -> click final confirmLabel button to execute
 */
export function confirmAction({
  title = 'Confirmar ação',
  message = 'Tem certeza que deseja continuar?',
  detail = '',
  confirmLabel = 'Confirmar agora',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const detailEl = document.getElementById('confirm-detail');
    const step1El = document.getElementById('confirm-step-1');
    const step2El = document.getElementById('confirm-step-2');
    const step2Warn = document.getElementById('confirm-step2-warn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const okBtn = document.getElementById('confirm-ok-btn');

    let step = 1;

    titleEl.textContent = title;
    msgEl.textContent = message;
    if (detail) {
      detailEl.textContent = detail;
      detailEl.classList.remove('hidden');
    } else {
      detailEl.textContent = '';
      detailEl.classList.add('hidden');
    }

    step1El.classList.add('active');
    step2El.classList.remove('active');
    step2Warn.classList.add('hidden');

    okBtn.textContent = 'Continuar →';
    okBtn.className = `btn ${danger ? 'btn-warn' : 'btn-primary'}`;

    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('open'));

    const cleanup = (result) => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.classList.add('hidden'), 180);
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };
    const onOk = () => {
      if (step === 1) {
        step = 2;
        step1El.classList.remove('active');
        step1El.classList.add('done');
        step2El.classList.add('active');
        step2Warn.classList.remove('hidden');
        okBtn.textContent = confirmLabel;
        okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
        return;
      }
      step1El.classList.remove('done');
      cleanup(true);
    };

    step1El.classList.remove('done');
    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Glass Input Prompt Modal (replaces native window.prompt)
 */
export function promptInput({
  title = 'Digite um valor',
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'Confirmar',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-modal');
    const form = document.getElementById('prompt-form');
    const titleEl = document.getElementById('prompt-title');
    const labelEl = document.getElementById('prompt-label');
    const inputEl = document.getElementById('prompt-input');
    const cancelBtn = document.getElementById('prompt-cancel-btn');
    const okBtn = document.getElementById('prompt-ok-btn');

    titleEl.textContent = title;
    labelEl.textContent = label;
    inputEl.value = value;
    inputEl.placeholder = placeholder;
    okBtn.textContent = confirmLabel;

    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      overlay.classList.add('open');
      inputEl.focus();
      inputEl.select();
    });

    const cleanup = (result) => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.classList.add('hidden'), 180);
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onSubmit = (e) => {
      e.preventDefault();
      const val = inputEl.value.trim();
      if (!val) return;
      cleanup(val);
    };
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(null);
    };

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
