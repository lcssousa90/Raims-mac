/**
 * App 4: Arquivos (Finder) — Navegação completa (/), Bookmarks, Upload + 1-Click Install/Exec,
 * Download, Nova Pasta, Renomear, Apagar (2-step), e Editor de Texto com Backup .bak e Validação.
 */

import { apiFetch, apiUploadFile, buildDownloadUrl } from '../api.js';
import { Icons, showToast, confirmAction, promptInput } from '../ui.js';
import { esc, formatBytes, formatTimestamp, isExecutableUpload, joinPath } from '../utils.js';

export function mountFilesApp(container) {
  let currentPath = '/root';
  try {
    const requested = sessionStorage.getItem('mothos.files.openPath');
    if (requested && requested.startsWith('/')) {
      currentPath = requested;
      sessionStorage.removeItem('mothos.files.openPath');
    }
  } catch {
    // Ignore storage access errors
  }
  let parentPath = '/';
  let entries = [];
  let bookmarks = [];
  let filterText = '';
  let lastUploaded = null;
  let editorState = null; // { path, content, original, size, truncated, backup, validate, validationError, saving }
  let destroyed = false;

  container.innerHTML = `
    <div class="app-stack files-app">
      <!-- Finder View -->
      <div id="files-browser-view" class="app-stack">
        <!-- Quick Bookmarks -->
        <div class="bookmark-bar" id="files-bookmarks"></div>

        <!-- Path Breadcrumbs & Toolbar -->
        <div class="glass-card files-toolbar-card">
          <div class="breadcrumb-row">
            <button type="button" class="btn btn-sm btn-ghost" id="files-up-btn" title="Subir diretório">
              <span class="btn-icon">${Icons.up}</span>
            </button>
            <div class="breadcrumbs" id="files-breadcrumbs"></div>
            <button type="button" class="btn btn-sm btn-ghost" id="files-refresh-btn" title="Atualizar lista">
              <span class="btn-icon">${Icons.refresh}</span>
            </button>
          </div>

          <div class="files-actions-bar">
            <div class="files-actions-left">
              <input type="file" id="files-upload-input" class="hidden">
              <button type="button" class="btn btn-sm btn-primary" id="files-upload-btn">
                <span class="btn-icon">${Icons.upload}</span> Upload
              </button>
              <button type="button" class="btn btn-sm btn-ghost" id="files-mkdir-btn">
                <span class="btn-icon">${Icons.plus}</span> Nova Pasta
              </button>
            </div>
            <input type="search" id="files-filter-input" class="glass-input glass-input-sm" placeholder="Filtrar nesta pasta...">
          </div>

          <!-- Post-upload quick install banner -->
          <div class="upload-banner hidden" id="files-upload-banner">
            <div class="upload-banner-text" id="files-upload-banner-text"></div>
            <div class="upload-banner-actions">
              <button type="button" class="btn btn-sm btn-cyan hidden" id="files-upload-exec-btn">
                <span class="btn-icon">${Icons.play}</span> Instalar / Executar
              </button>
              <button type="button" class="btn btn-sm btn-ghost" id="files-upload-dismiss-btn">Fechar</button>
            </div>
          </div>

          <!-- Exec Output Console -->
          <div class="exec-result-wrap hidden" id="files-exec-wrap">
            <div class="exec-result-head">
              <strong id="files-exec-title">Saída da execução</strong>
              <button type="button" class="btn btn-xs btn-ghost" id="files-exec-close">Ocultar</button>
            </div>
            <pre class="console-box" id="files-exec-output"></pre>
          </div>
        </div>

        <!-- Directory Listing -->
        <div class="glass-card files-list-card">
          <div class="files-list" id="files-list">
            <div class="empty-note">Carregando arquivos...</div>
          </div>
        </div>
      </div>

      <!-- Built-in Text Editor Subview -->
      <div id="files-editor-view" class="app-stack hidden">
        <div class="glass-card editor-card">
          <div class="editor-head">
            <button type="button" class="btn btn-sm btn-ghost" id="editor-back-btn">← Voltar aos Arquivos</button>
            <div class="editor-path mono" id="editor-path"></div>
            <span class="pill pill-xs pill-amber hidden" id="editor-dirty-pill">Não salvo</span>
          </div>

          <div class="banner banner-warn hidden" id="editor-truncated-banner">
            Arquivo truncado (limite de 512 KB para leitura). Salvar pode sobrescrever o conteúdo restante — faça download antes se necessário.
          </div>

          <div class="banner banner-danger hidden" id="editor-error-banner">
            <div class="banner-title">Falha na validação de sintaxe — arquivo não foi alterado</div>
            <pre class="banner-pre" id="editor-error-detail"></pre>
          </div>

          <textarea id="editor-textarea" class="code-editor" spellcheck="false" autocomplete="off"></textarea>

          <div class="editor-footer">
            <div class="editor-toggles">
              <label class="toggle-chip">
                <input type="checkbox" id="editor-backup-toggle" checked>
                <span>Backup <code>.bak</code></span>
              </label>
              <label class="toggle-chip">
                <input type="checkbox" id="editor-validate-toggle" checked>
                <span>Validar sintaxe</span>
              </label>
              <span class="editor-stats mono" id="editor-stats">0 linhas</span>
            </div>

            <div class="editor-buttons">
              <button type="button" class="btn btn-ghost" id="editor-cancel-btn">Descartar</button>
              <button type="button" class="btn btn-primary" id="editor-save-btn">
                <span class="btn-icon">${Icons.save}</span> Salvar Arquivo
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const refs = {
    browserView: container.querySelector('#files-browser-view'),
    editorView: container.querySelector('#files-editor-view'),
    bookmarksEl: container.querySelector('#files-bookmarks'),
    breadcrumbsEl: container.querySelector('#files-breadcrumbs'),
    upBtn: container.querySelector('#files-up-btn'),
    refreshBtn: container.querySelector('#files-refresh-btn'),
    uploadInput: container.querySelector('#files-upload-input'),
    uploadBtn: container.querySelector('#files-upload-btn'),
    mkdirBtn: container.querySelector('#files-mkdir-btn'),
    filterInput: container.querySelector('#files-filter-input'),
    uploadBanner: container.querySelector('#files-upload-banner'),
    uploadBannerText: container.querySelector('#files-upload-banner-text'),
    uploadExecBtn: container.querySelector('#files-upload-exec-btn'),
    uploadDismissBtn: container.querySelector('#files-upload-dismiss-btn'),
    execWrap: container.querySelector('#files-exec-wrap'),
    execTitle: container.querySelector('#files-exec-title'),
    execOutput: container.querySelector('#files-exec-output'),
    execClose: container.querySelector('#files-exec-close'),
    listEl: container.querySelector('#files-list'),
    // Editor
    editorBackBtn: container.querySelector('#editor-back-btn'),
    editorPath: container.querySelector('#editor-path'),
    editorDirtyPill: container.querySelector('#editor-dirty-pill'),
    editorTruncated: container.querySelector('#editor-truncated-banner'),
    editorErrorBanner: container.querySelector('#editor-error-banner'),
    editorErrorDetail: container.querySelector('#editor-error-detail'),
    editorTextarea: container.querySelector('#editor-textarea'),
    editorBackup: container.querySelector('#editor-backup-toggle'),
    editorValidate: container.querySelector('#editor-validate-toggle'),
    editorStats: container.querySelector('#editor-stats'),
    editorCancelBtn: container.querySelector('#editor-cancel-btn'),
    editorSaveBtn: container.querySelector('#editor-save-btn'),
  };

  function iconForEntry(entry) {
    if (entry.is_dir) return `<span class="file-icon file-icon-dir">${Icons.folder}</span>`;
    const lower = String(entry.name || '').toLowerCase();
    if (isExecutableUpload(lower)) {
      return `<span class="file-icon file-icon-pkg">${Icons.pkg}</span>`;
    }
    if (/\.(sh|py|json|plist|conf|cfg|service|yaml|yml|toml|xml|md|txt|log|env|js|css|html)$/.test(lower)) {
      return `<span class="file-icon file-icon-code">${Icons.code}</span>`;
    }
    return `<span class="file-icon file-icon-bin">${Icons.file}</span>`;
  }

  function renderBookmarks() {
    refs.bookmarksEl.innerHTML = bookmarks
      .map(
        (bm) => `
        <button type="button" class="bookmark-pill ${currentPath === bm.path ? 'active' : ''}" data-nav-path="${esc(bm.path)}">
          ${esc(bm.label)}
        </button>
      `
      )
      .join('');
  }

  function renderBreadcrumbs() {
    const parts = currentPath.split('/').filter(Boolean);
    const crumbs = [`<button type="button" class="crumb-btn ${parts.length === 0 ? 'active' : ''}" data-nav-path="/">/</button>`];
    let acc = '';
    parts.forEach((seg, idx) => {
      acc += `/${seg}`;
      const isLast = idx === parts.length - 1;
      crumbs.push(`<span class="crumb-sep">/</span>`);
      crumbs.push(
        `<button type="button" class="crumb-btn ${isLast ? 'active' : ''}" data-nav-path="${esc(acc)}">${esc(seg)}</button>`
      );
    });
    refs.breadcrumbsEl.innerHTML = crumbs.join('');
    refs.upBtn.disabled = currentPath === '/';
  }

  function renderEntries() {
    const query = filterText.trim().toLowerCase();
    const visible = entries.filter((item) => !query || String(item.name || '').toLowerCase().includes(query));

    if (visible.length === 0) {
      refs.listEl.innerHTML = `<div class="empty-note">${query ? 'Nenhum item corresponde ao filtro.' : 'Pasta vazia.'}</div>`;
      return;
    }

    refs.listEl.innerHTML = visible
      .map((item) => {
        const execable = !item.is_dir && isExecutableUpload(item.name);
        const pathAttr = esc(item.path);
        const nameEsc = esc(item.name);
        const canDelete = item.path !== '/';

        return `
          <div class="file-row">
            <button type="button" class="file-main-btn" data-open-entry="${pathAttr}" data-is-dir="${item.is_dir ? '1' : '0'}">
              ${iconForEntry(item)}
              <div class="file-info">
                <div class="file-name">
                  ${nameEsc}
                  ${item.is_symlink ? '<span class="pill pill-xs pill-muted">symlink</span>' : ''}
                </div>
                <div class="file-meta mono">
                  ${item.is_dir ? 'Pasta' : esc(formatBytes(item.size))} • ${esc(item.mode || '—')} • ${esc(formatTimestamp(item.mtime))}
                </div>
              </div>
            </button>

            <div class="file-row-actions">
              ${
                execable
                  ? `<button type="button" class="btn btn-xs btn-cyan" data-exec-path="${pathAttr}" title="Instalar / Executar">Executar</button>`
                  : ''
              }
              ${
                !item.is_dir
                  ? `<button type="button" class="icon-btn icon-btn-sm" data-edit-path="${pathAttr}" title="Editar texto">${Icons.edit}</button>
                     <a class="icon-btn icon-btn-sm" href="${esc(buildDownloadUrl(item.path))}" download="${nameEsc}" title="Baixar arquivo">${Icons.download}</a>`
                  : ''
              }
              <button type="button" class="icon-btn icon-btn-sm" data-rename-path="${pathAttr}" data-rename-name="${nameEsc}" title="Renomear">Aa</button>
              ${
                canDelete
                  ? `<button type="button" class="icon-btn icon-btn-sm icon-btn-danger" data-delete-path="${pathAttr}" data-delete-name="${nameEsc}" data-is-dir="${item.is_dir ? '1' : '0'}" title="Apagar">${Icons.trash}</button>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function loadBookmarks() {
    try {
      const res = await apiFetch('/api/files/bookmarks');
      bookmarks = Array.isArray(res.bookmarks) ? res.bookmarks : [];
      renderBookmarks();
    } catch {
      bookmarks = [
        { label: 'Root', path: '/root' },
        { label: 'Temp', path: '/tmp' },
        { label: 'Sistema (/)', path: '/' },
      ];
      renderBookmarks();
    }
  }

  async function navigate(targetPath, fallbackOnError = false) {
    try {
      const res = await apiFetch(`/api/files/list?path=${encodeURIComponent(targetPath)}`);
      if (destroyed) return;
      currentPath = res.path || targetPath;
      parentPath = res.parent || '/';
      const raw = Array.isArray(res.entries) ? res.entries : [];
      raw.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR', { sensitivity: 'base' });
      });
      entries = raw;
      renderBookmarks();
      renderBreadcrumbs();
      renderEntries();
    } catch (err) {
      if (fallbackOnError && targetPath !== '/tmp') {
        navigate('/tmp', false);
        return;
      }
      showToast(`Erro ao abrir "${targetPath}": ${err.message}`, 'error');
    }
  }

  async function openEditor(filePath) {
    try {
      const res = await apiFetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      if (destroyed) return;

      if (res.is_binary) {
        showToast('Arquivo binário detectado. Use o botão Download para baixá-lo.', 'warn');
        return;
      }

      editorState = {
        path: res.path || filePath,
        content: res.content || '',
        original: res.content || '',
        size: res.size || 0,
        truncated: Boolean(res.truncated),
        saving: false,
      };

      refs.editorPath.textContent = editorState.path;
      refs.editorTextarea.value = editorState.content;
      refs.editorBackup.checked = true;
      refs.editorValidate.checked = true;
      refs.editorTruncated.classList.toggle('hidden', !editorState.truncated);
      refs.editorErrorBanner.classList.add('hidden');
      refs.editorErrorDetail.textContent = '';
      updateEditorStats();

      refs.browserView.classList.add('hidden');
      refs.editorView.classList.remove('hidden');
      refs.editorTextarea.focus();
    } catch (err) {
      showToast(`Erro ao ler arquivo: ${err.message}`, 'error');
    }
  }

  function updateEditorStats() {
    if (!editorState) return;
    const val = refs.editorTextarea.value;
    const lines = val ? val.split('\n').length : 0;
    const dirty = val !== editorState.original;
    refs.editorDirtyPill.classList.toggle('hidden', !dirty);
    refs.editorStats.textContent = `${lines} linhas • ${val.length} chars`;
  }

  function closeEditor() {
    editorState = null;
    refs.editorView.classList.add('hidden');
    refs.browserView.classList.remove('hidden');
  }

  async function saveEditor() {
    if (!editorState || editorState.saving) return;
    editorState.saving = true;
    refs.editorSaveBtn.disabled = true;
    refs.editorErrorBanner.classList.add('hidden');

    try {
      const content = refs.editorTextarea.value;
      const res = await apiFetch('/api/files/write', {
        method: 'POST',
        body: {
          path: editorState.path,
          content,
          backup: refs.editorBackup.checked,
          validate: refs.editorValidate.checked,
        },
      });
      editorState.original = content;
      editorState.content = content;
      updateEditorStats();
      const bakNote = res.backup_path ? ` • Backup: ${res.backup_path}` : '';
      const valNote = res.validation === 'ok' ? ' • Sintaxe OK' : '';
      showToast(`Arquivo salvo com sucesso${valNote}${bakNote}`, 'success', 4500);
      navigate(currentPath);
    } catch (err) {
      if (err.status === 422) {
        const detail = (err.data && (err.data.detail || err.data.error)) || err.message;
        refs.editorErrorDetail.textContent = detail;
        refs.editorErrorBanner.classList.remove('hidden');
        showToast('Erro de sintaxe! Corrija o código antes de salvar.', 'error', 4500);
      } else {
        showToast(`Erro ao salvar arquivo: ${err.message}`, 'error');
      }
    } finally {
      if (editorState) editorState.saving = false;
      refs.editorSaveBtn.disabled = false;
    }
  }

  async function handleMkdir() {
    const name = await promptInput({
      title: 'Nova Pasta',
      label: `Criar subpasta dentro de ${currentPath}`,
      placeholder: 'nome-da-pasta',
      confirmLabel: 'Criar Pasta',
    });
    if (!name) return;
    if (name.includes('/')) {
      showToast('Use apenas o nome da pasta, sem barras "/".', 'warn');
      return;
    }

    try {
      const fullPath = joinPath(currentPath, name);
      await apiFetch('/api/files/mkdir', {
        method: 'POST',
        body: { path: fullPath },
      });
      showToast(`Pasta "${name}" criada.`, 'success');
      navigate(currentPath);
    } catch (err) {
      showToast(`Erro ao criar pasta: ${err.message}`, 'error');
    }
  }

  async function handleRename(oldPath, oldName) {
    const newName = await promptInput({
      title: 'Renomear item',
      label: `Novo nome para "${oldName}"`,
      value: oldName,
      confirmLabel: 'Renomear',
    });
    if (!newName || newName === oldName) return;

    const dir = oldPath.slice(0, oldPath.lastIndexOf('/')) || '/';
    const newPath = newName.startsWith('/') ? newName : joinPath(dir, newName);

    try {
      await apiFetch('/api/files/rename', {
        method: 'POST',
        body: { old_path: oldPath, new_path: newPath },
      });
      showToast(`Renomeado para "${newName}".`, 'success');
      navigate(currentPath);
    } catch (err) {
      showToast(`Erro ao renomear: ${err.message}`, 'error');
    }
  }

  async function handleDelete(targetPath, name, isDir) {
    const ok = await confirmAction({
      title: isDir ? 'Apagar Pasta Permanentemente' : 'Apagar Arquivo Permanentemente',
      message: `Deseja remover "${name}"? Esta ação não pode ser desfeita.`,
      detail: `Caminho completo: ${targetPath}${isDir ? ' (remoção recursiva de todo o conteúdo)' : ''}`,
      confirmLabel: 'Apagar Agora',
      danger: true,
    });
    if (!ok) return;

    try {
      await apiFetch('/api/files/delete', {
        method: 'POST',
        body: { path: targetPath, confirm: true },
      });
      showToast(`"${name}" apagado com sucesso.`, 'success');
      navigate(currentPath);
    } catch (err) {
      showToast(`Erro ao apagar: ${err.message}`, 'error');
    }
  }

  async function handleUpload(file) {
    if (!file) return;
    refs.uploadBtn.disabled = true;
    try {
      const res = await apiUploadFile(currentPath, file);
      lastUploaded = res;
      showToast(`Upload concluído: ${file.name} (${formatBytes(res.size)})`, 'success');

      refs.uploadBannerText.textContent = `Enviado: ${res.path} (${formatBytes(res.size)})`;
      refs.uploadExecBtn.classList.toggle('hidden', !isExecutableUpload(res.path));
      refs.uploadBanner.classList.remove('hidden');

      await navigate(currentPath);
    } catch (err) {
      showToast(`Falha no upload: ${err.message}`, 'error');
    } finally {
      refs.uploadBtn.disabled = false;
      refs.uploadInput.value = '';
    }
  }

  async function handleExec(filePath) {
    const lower = String(filePath).toLowerCase();
    let modeDesc = 'Executar arquivo no host Linux';
    if (lower.endsWith('.deb')) modeDesc = 'Instalar pacote Debian com dpkg -i';
    else if (lower.endsWith('.sh')) modeDesc = 'Executar script com bash';
    else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) modeDesc = 'Extrair arquivo tar.gz na pasta atual';

    const ok = await confirmAction({
      title: 'Instalar / Executar Arquivo',
      message: `${modeDesc}?`,
      detail: filePath,
      confirmLabel: 'Executar Agora',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await apiFetch('/api/files/exec', {
        method: 'POST',
        body: { path: filePath, confirm: true },
      });
      refs.execTitle.textContent = `Execução (${res.ok ? 'OK' : 'ERRO'} • código ${res.returncode})`;
      refs.execOutput.textContent = res.output || '(sem saída)';
      refs.execWrap.classList.remove('hidden');
      showToast(
        res.ok ? `Executado com sucesso (código ${res.returncode}).` : `Execução falhou (código ${res.returncode}).`,
        res.ok ? 'success' : 'error'
      );
      navigate(currentPath);
    } catch (err) {
      showToast(`Erro ao executar: ${err.message}`, 'error');
    }
  }

  // Event bindings
  refs.upBtn.addEventListener('click', () => navigate(parentPath));
  refs.refreshBtn.addEventListener('click', () => navigate(currentPath));
  refs.mkdirBtn.addEventListener('click', handleMkdir);
  refs.uploadBtn.addEventListener('click', () => refs.uploadInput.click());
  refs.uploadInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleUpload(file);
  });
  refs.uploadExecBtn.addEventListener('click', () => {
    if (lastUploaded && lastUploaded.path) handleExec(lastUploaded.path);
  });
  refs.uploadDismissBtn.addEventListener('click', () => refs.uploadBanner.classList.add('hidden'));
  refs.execClose.addEventListener('click', () => refs.execWrap.classList.add('hidden'));

  refs.filterInput.addEventListener('input', (e) => {
    filterText = e.target.value;
    renderEntries();
  });

  refs.editorBackBtn.addEventListener('click', closeEditor);
  refs.editorCancelBtn.addEventListener('click', closeEditor);
  refs.editorSaveBtn.addEventListener('click', saveEditor);
  refs.editorTextarea.addEventListener('input', updateEditorStats);
  refs.editorTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = refs.editorTextarea.selectionStart;
      const end = refs.editorTextarea.selectionEnd;
      const val = refs.editorTextarea.value;
      refs.editorTextarea.value = `${val.slice(0, start)}  ${val.slice(end)}`;
      refs.editorTextarea.selectionStart = refs.editorTextarea.selectionEnd = start + 2;
      updateEditorStats();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveEditor();
    }
  });

  container.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-nav-path]');
    if (navBtn) {
      filterText = '';
      refs.filterInput.value = '';
      navigate(navBtn.dataset.navPath);
      return;
    }

    const openBtn = e.target.closest('[data-open-entry]');
    if (openBtn) {
      const target = openBtn.dataset.openEntry;
      if (openBtn.dataset.isDir === '1') {
        filterText = '';
        refs.filterInput.value = '';
        navigate(target);
      } else {
        openEditor(target);
      }
      return;
    }

    const editBtn = e.target.closest('[data-edit-path]');
    if (editBtn) {
      openEditor(editBtn.dataset.editPath);
      return;
    }

    const execBtn = e.target.closest('[data-exec-path]');
    if (execBtn) {
      handleExec(execBtn.dataset.execPath);
      return;
    }

    const renameBtn = e.target.closest('[data-rename-path]');
    if (renameBtn) {
      handleRename(renameBtn.dataset.renamePath, renameBtn.dataset.renameName);
      return;
    }

    const delBtn = e.target.closest('[data-delete-path]');
    if (delBtn) {
      handleDelete(delBtn.dataset.deletePath, delBtn.dataset.deleteName, delBtn.dataset.isDir === '1');
    }
  });

  loadBookmarks().then(() => {
    if (!destroyed) navigate('/root', true);
  });

  return () => {
    destroyed = true;
  };
}
