function buildUrl(path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  if (normalizedPath.startsWith('/api/')) {
    return normalizedPath;
  }
  return `/api${normalizedPath}`;
}

export async function apiFetch(path, options = {}) {
  const primaryUrl = buildUrl(path);
  let response = await fetch(primaryUrl, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok && response.status === 404 && primaryUrl.startsWith('/api/')) {
    const fallbackUrl = primaryUrl.replace(/^\/api\//, '/');
    response = await fetch(fallbackUrl, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
  }

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `API error: ${response.status}`);
  }
  return payload;
}

export function getApiBaseUrl() {
  return '';
}
