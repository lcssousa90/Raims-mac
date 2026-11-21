/**
 * MothOS HTTP & WebSocket API client
 */

const TOKEN_STORAGE_KEY = 'mothos_session_token';

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors in private mode
  }
}

export function clearToken() {
  setToken('');
}

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, headers = {}, signal, skipAuthRedirect = false } = options;

  const reqHeaders = { ...headers };
  const token = getToken();
  if (token && !reqHeaders.Authorization) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  let fetchBody = body;
  if (body !== undefined && body !== null && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !(body instanceof FormData) && typeof body !== 'string') {
    reqHeaders['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(path, {
    method,
    headers: reqHeaders,
    body: fetchBody,
    credentials: 'same-origin',
    signal,
  });

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    data = text ? { message: text } : null;
  }

  if (!response.ok) {
    if (response.status === 401 && !skipAuthRedirect) {
      clearToken();
      if (unauthorizedHandler) unauthorizedHandler();
    }
    const msg =
      (data && (data.detail || data.message || data.error)) ||
      `Erro HTTP ${response.status}`;
    throw new ApiError(msg, response.status, data);
  }

  return data;
}

export async function apiUploadFile(dir, file) {
  const token = getToken();
  const headers = {
    'X-Filename': file.name,
    'Content-Type': 'application/octet-stream',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `/api/files/upload?dir=${encodeURIComponent(dir)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: file,
    credentials: 'same-origin',
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearToken();
      if (unauthorizedHandler) unauthorizedHandler();
    }
    const msg = (data && (data.detail || data.message || data.error)) || `Falha no upload (${response.status})`;
    throw new ApiError(msg, response.status, data);
  }
  return data;
}

export function buildDownloadUrl(filePath) {
  return `/api/files/download?path=${encodeURIComponent(filePath)}`;
}

export function buildWsUrl(wsPath) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const sep = wsPath.includes('?') ? '&' : '?';
  const query = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}${wsPath}${query}`;
}
