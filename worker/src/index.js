import { AwsClient } from 'aws4fetch';

const WINES_KEY = 'wines';
const LABEL_RECORD_PREFIX = 'label-record:';
const LABEL_INDEX_KEY = 'label-index';
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIND_LATEST_PREFIX = 'mind:latest:';
const MIND_MANIFEST_PREFIX = 'mind:manifest:';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) {
    return '';
  }

  const configured = String(env.ALLOWED_ORIGIN || '').trim();
  if (!configured) {
    return origin;
  }

  const patterns = configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => new RegExp(`^${escapeRegExp(item).replace(/\\\*/g, '.*')}$`));

  return patterns.some((pattern) => pattern.test(origin)) ? origin : 'null';
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const pairs = header.split(';').map((part) => part.trim()).filter(Boolean);
  const cookies = {};
  pairs.forEach((pair) => {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      return;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    cookies[key] = value;
  });
  return cookies;
}

function buildSessionCookie(token, maxAgeSeconds = SESSION_TTL_SECONDS) {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

function sessionKey(token) {
  return `${SESSION_PREFIX}${token}`;
}

async function getSessionFromRequest(request, env) {
  const token = String(parseCookies(request).session || '').trim();
  if (!token) {
    return null;
  }
  const raw = await env.WINES_KV.get(sessionKey(token));
  if (!raw) {
    return null;
  }
  try {
    const session = JSON.parse(raw);
    return {
      token,
      session,
    };
  } catch {
    return null;
  }
}

async function requireAdmin(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return null;
  }
  return session;
}

async function hasAdminAccess(request, env) {
  const session = await requireAdmin(request, env);
  if (session) {
    return true;
  }
  return isAdminRequest(request, env);
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function verifyTurnstile(turnstileToken, request, env) {
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!turnstileToken || !secret) {
    return !turnstileToken;
  }
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', turnstileToken);
  if (ip) {
    body.set('remoteip', ip);
  }
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!response.ok) {
    return false;
  }
  const payload = await response.json().catch(() => null);
  return Boolean(payload?.success);
}

function getAwsClient(env) {
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const accountId = String(env.CF_ACCOUNT_ID || '').trim();
  if (!accessKeyId || !secretAccessKey || !accountId) {
    return null;
  }
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

function getR2S3Base(env) {
  const accountId = String(env.CF_ACCOUNT_ID || '').trim();
  const bucket = String(env.R2_BUCKET || '').trim();
  if (!accountId || !bucket) {
    return '';
  }
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
}

function getR2PublicBase(env) {
  const base = String(env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return base;
}

async function fetchR2Object(env, key) {
  const aws = getAwsClient(env);
  const base = getR2S3Base(env);
  if (!aws || !base) {
    throw new Error('R2 credentials are not configured.');
  }
  const response = await aws.fetch(`${base}/${key}`, {
    method: 'GET',
  });
  return response;
}

async function createPresignedUrl(env, { method, key, expiresIn = 600, contentType = '' }) {
  const aws = getAwsClient(env);
  const base = getR2S3Base(env);
  if (!aws || !base) {
    throw new Error('R2 credentials are not configured.');
  }
  const urlObj = new URL(`${base}/${key}`);
  urlObj.searchParams.set('X-Amz-Expires', String(expiresIn));
  const headers = {};
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  const signed = await aws.sign(urlObj.toString(), {
    method,
    headers,
    aws: {
      signQuery: true,
      allHeaders: true,
    },
  });
  return {
    url: signed.url,
    requiredHeaders: contentType ? { 'Content-Type': contentType } : {},
  };
}

function getMindLatestKey(wineId) {
  return `${MIND_LATEST_PREFIX}${wineId}`;
}

function getMindManifestKey(wineId) {
  return `${MIND_MANIFEST_PREFIX}${wineId}`;
}

function normalizeMindShard(value, fallbackIndex = 0) {
  const id = String(value?.id || `shard-${fallbackIndex}`).trim() || `shard-${fallbackIndex}`;
  const key = String(value?.key || '').trim();
  const hash = String(value?.hash || '').trim() || null;
  const targetCount = Number.parseInt(value?.targetCount, 10) || 0;
  const targetWineMap = normalizeTargetWineMap(value?.targetWineMap);
  return {
    id,
    key,
    hash,
    targetCount,
    targetWineMap,
  };
}

function normalizeMindShards(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => normalizeMindShard(item, index))
    .filter((item) => item.key);
}

function normalizeWine(wine, fallbackIndex = 0) {
  const targetIndex = Number.parseInt(wine?.targetIndex, 10);
  const rating = Number.parseFloat(wine?.rating);
  const status = String(wine?.status || '').trim().toLowerCase() === 'draft' ? 'draft' : 'published';
  const clampPercent = (value, fallback = 50) => {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(100, Math.max(0, num));
  };

  return {
    id: String(wine?.id || `wine-${fallbackIndex + 1}`).trim(),
    targetIndex: Number.isInteger(targetIndex) && targetIndex >= 0 ? targetIndex : fallbackIndex,
    title: String(wine?.title || '').trim(),
    subtitle: String(wine?.subtitle || wine?.region || '').trim(),
    story: String(wine?.story || '').trim(),
    serving: String(wine?.serving || '').trim(),
    producer: String(wine?.producer || '').trim(),
    region: String(wine?.region || '').trim(),
    year: String(wine?.year || '').trim(),
    grapes: String(wine?.grapes || '').trim(),
    estateClass: String(wine?.estateClass || '').trim(),
    description: String(wine?.description || '').trim(),
    abv: String(wine?.abv || '').trim(),
    inventory: String(wine?.inventory || '').trim(),
    body: clampPercent(wine?.body, 50),
    tannins: clampPercent(wine?.tannins, 50),
    acidity: clampPercent(wine?.acidity, 50),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, Number(rating.toFixed(1)))) : 0,
    labelImage: String(wine?.labelImage || '').trim(),
    labelAssets: Array.isArray(wine?.labelAssets)
      ? wine.labelAssets.map((asset, index) => ({
        id: String(asset?.id || `asset-${index + 1}`).trim(),
        role: String(asset?.role || '').trim(),
        dataUrl: String(asset?.dataUrl || '').trim(),
        qualityScore: Number.parseInt(asset?.qualityScore, 10) || 0,
        qualityStatus: String(asset?.qualityStatus || '').trim() || 'unknown',
        qualityNotes: Array.isArray(asset?.qualityNotes)
          ? asset.qualityNotes.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        visualEmbedding: normalizeEmbedding(asset?.visualEmbedding),
      })).filter((asset) => asset.dataUrl)
      : [],
    visualEmbedding: normalizeEmbedding(wine?.visualEmbedding),
    qualityScore: Number.parseInt(wine?.qualityScore, 10) || 0,
    qualityStatus: String(wine?.qualityStatus || '').trim() || 'unknown',
    qualityNotes: Array.isArray(wine?.qualityNotes)
      ? wine.qualityNotes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    status,
    palateNotes: Array.isArray(wine?.palateNotes) ? wine.palateNotes.map((x) => String(x || '').trim()).filter(Boolean) : [],
    pairings: Array.isArray(wine?.pairings) ? wine.pairings.map((x) => String(x || '').trim()).filter(Boolean) : [],
    gallery: Array.isArray(wine?.gallery) ? wine.gallery.map((x) => String(x || '').trim()).filter(Boolean) : [],
  };
}

function normalizeWines(wines) {
  return (wines || []).map((wine, index) => normalizeWine(wine, index));
}

function validateWine(wine) {
  if (!wine.id) {
    throw new Error('Field "id" is required.');
  }
  const isDraft = wine.status === 'draft';
  if (!isDraft && (!wine.title || !wine.story || !wine.serving)) {
    throw new Error('Required fields: title, story, serving.');
  }
  if (!Number.isInteger(wine.targetIndex) || wine.targetIndex < 0) {
    throw new Error('targetIndex must be an integer >= 0.');
  }
  if (!Number.isFinite(wine.rating) || wine.rating < 0 || wine.rating > 5) {
    throw new Error('rating must be between 0 and 5.');
  }
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => Number.parseFloat(item))
    .filter((item) => Number.isFinite(item));
}

function normalizeQueryText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number.parseFloat(a[i]);
    const y = Number.parseFloat(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scoreWineByText(wine, query) {
  const q = normalizeQueryText(query);
  if (!q) {
    return { score: 0, fieldsMatched: [] };
  }

  const fields = [
    ['title', wine.title],
    ['producer', wine.producer],
    ['region', wine.region],
    ['subtitle', wine.subtitle],
    ['year', wine.year],
    ['grapes', wine.grapes],
  ];

  const fieldsMatched = [];
  let score = 0;
  for (let i = 0; i < fields.length; i += 1) {
    const [fieldName, fieldValue] = fields[i];
    const normalized = normalizeQueryText(fieldValue);
    if (!normalized) {
      continue;
    }
    if (normalized.includes(q) || q.includes(normalized)) {
      score += fieldName === 'title' ? 1 : 0.65;
      fieldsMatched.push(fieldName);
      continue;
    }

    const queryTokens = q.split(' ').filter(Boolean);
    const fieldTokens = new Set(normalized.split(' ').filter(Boolean));
    const tokenHits = queryTokens.filter((token) => fieldTokens.has(token)).length;
    if (tokenHits) {
      score += (tokenHits / Math.max(queryTokens.length, 1)) * (fieldName === 'title' ? 0.85 : 0.5);
      fieldsMatched.push(fieldName);
    }
  }

  return {
    score: Number(score.toFixed(4)),
    fieldsMatched: [...new Set(fieldsMatched)],
  };
}

async function getWines(env) {
  const raw = await env.WINES_KV.get(WINES_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.wines) ? parsed.wines : [];
  } catch {
    return [];
  }
}

async function saveWines(env, wines) {
  await env.WINES_KV.put(WINES_KEY, JSON.stringify({ wines }));
}

function makeLabelRecordKey(labelHash) {
  return `${LABEL_RECORD_PREFIX}${labelHash}`;
}

async function getLabelRecord(env, labelHash) {
  const raw = await env.WINES_KV.get(makeLabelRecordKey(labelHash));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getLabelIndex(env) {
  const raw = await env.WINES_KV.get(LABEL_INDEX_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function isAdminRequest(request, env) {
  const expected = String(env.TARGETS_ADMIN_KEY || '').trim();
  const received = String(request.headers.get('x-admin-key') || '').trim();
  return expected && received && expected === received;
}

function normalizeTargetWineMap(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => ({
      wineId: String(item?.wineId || '').trim(),
      role: String(item?.role || '').trim() || null,
      assetHash: String(item?.assetHash || '').trim() || null,
    }))
    .filter((item) => item.wineId);
}

async function extractOcrDataFromImage(dataUrl, env) {
  const apiKey = String(env.OCR_SPACE_API_KEY || '').trim();
  if (!apiKey || !dataUrl) {
    return { text: '', lines: [] };
  }

  const body = new URLSearchParams();
  body.set('apikey', apiKey);
  body.set('base64Image', dataUrl);
  body.set('language', 'eng');
  body.set('isOverlayRequired', 'true');
  body.set('OCREngine', '2');

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    return { text: '', lines: [] };
  }

  const payload = await response.json().catch(() => null);
  if (!payload || payload.IsErroredOnProcessing) {
    return { text: '', lines: [] };
  }

  const parsed = Array.isArray(payload.ParsedResults) ? payload.ParsedResults : [];
  const text = parsed
    .map((item) => String(item?.ParsedText || '').trim())
    .filter(Boolean)
    .join('\n');
  const lines = parsed
    .flatMap((item) => {
      const overlayLines = Array.isArray(item?.TextOverlay?.Lines) ? item.TextOverlay.Lines : [];
      return overlayLines.map((line) => ({
        text: String(line?.LineText || '').trim(),
        minTop: Number.parseFloat(line?.MinTop) || 0,
        maxHeight: Number.parseFloat(line?.MaxHeight) || 0,
      }));
    })
    .filter((line) => line.text);
  return { text, lines };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = getAllowedOrigin(request, env);
    const withRequestCorsHeaders = (headers = {}) => {
      const responseHeaders = { ...headers };
      if (allowedOrigin && allowedOrigin !== 'null') {
        responseHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
        responseHeaders['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
        responseHeaders['Access-Control-Allow-Headers'] = 'Content-Type,x-admin-key';
        responseHeaders.Vary = 'Origin';
        responseHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
      return responseHeaders;
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: withRequestCorsHeaders({
        'Content-Type': 'application/json',
      }),
    });
    const jsonWithHeaders = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
      status,
      headers: withRequestCorsHeaders({
        'Content-Type': 'application/json',
        ...extraHeaders,
      }),
    });

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: withRequestCorsHeaders(),
      });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const password = String(payload?.password || '');
        const isValidPassword = password && password === String(env.ADMIN_PASSWORD || '');
        if (!isValidPassword) {
          return json({ ok: false, error: 'Invalid credentials.' }, 401);
        }

        const turnstileToken = String(payload?.turnstileToken || '').trim();
        const turnstileOk = await verifyTurnstile(turnstileToken, request, env);
        if (!turnstileOk) {
          return json({ ok: false, error: 'Turnstile verification failed.' }, 400);
        }

        const token = await generateSessionToken();
        const session = {
          user: 'admin',
          createdAt: Date.now(),
        };
        await env.WINES_KV.put(sessionKey(token), JSON.stringify(session), {
          expirationTtl: SESSION_TTL_SECONDS,
        });

        return jsonWithHeaders(
          { ok: true },
          200,
          { 'Set-Cookie': buildSessionCookie(token) }
        );
      } catch (error) {
        return json({ ok: false, error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const session = await getSessionFromRequest(request, env);
      if (session?.token) {
        await env.WINES_KV.delete(sessionKey(session.token));
      }
      return jsonWithHeaders({ ok: true }, 200, {
        'Set-Cookie': clearSessionCookie(),
      });
    }

    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const session = await getSessionFromRequest(request, env);
      return json({
        authenticated: Boolean(session),
        user: session?.session?.user || null,
      });
    }

    if (url.pathname === '/api/admin/mind/presign-put' && request.method === 'POST') {
      const session = await requireAdmin(request, env);
      if (!session) {
        return json({ error: 'Unauthorized.' }, 401);
      }

      try {
        const payload = await request.json();
        const wineId = String(payload?.wineId || 'global').trim() || 'global';
        const hash = String(payload?.hash || '').trim();
        const shardId = String(payload?.shardId || '').trim() || 'shard-0';
        if (!hash) {
          return json({ error: 'hash is required.' }, 400);
        }

        const key = `mind/${wineId}/shards/${shardId}/${hash}.mind`;
        const presigned = await createPresignedUrl(env, {
          method: 'PUT',
          key,
          expiresIn: 600,
          contentType: 'application/octet-stream',
        });

        return json({
          putUrl: presigned.url,
          key,
          shardId,
          requiredHeaders: presigned.requiredHeaders,
        });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/admin/mind/finalize' && request.method === 'POST') {
      const session = await requireAdmin(request, env);
      if (!session) {
        return json({ error: 'Unauthorized.' }, 401);
      }

      try {
        const payload = await request.json();
        const wineId = String(payload?.wineId || 'global').trim() || 'global';
        const shards = normalizeMindShards(payload?.shards);
        if (!shards.length) {
          return json({ error: 'shards are required.' }, 400);
        }
        const updatedAt = Number.parseInt(payload?.updatedAt, 10) || Date.now();
        const totalTargets = shards.reduce((sum, shard) => sum + (Number.parseInt(shard.targetCount, 10) || 0), 0);
        const wineShardMap = {};
        shards.forEach((shard) => {
          shard.targetWineMap.forEach((item) => {
            if (item?.wineId) {
              wineShardMap[item.wineId] = shard.id;
            }
          });
        });

        const manifest = {
          wineId,
          ready: true,
          updatedAt,
          totalTargets,
          shardCount: shards.length,
          shards,
          wineShardMap,
        };
        await env.WINES_KV.put(getMindManifestKey(wineId), JSON.stringify(manifest));

        const firstShard = shards[0];
        if (firstShard) {
          await env.WINES_KV.put(
            getMindLatestKey(wineId),
            JSON.stringify({
              key: firstShard.key,
              hash: firstShard.hash,
              targetCount: firstShard.targetCount,
              targetWineMap: firstShard.targetWineMap,
              shardId: firstShard.id,
              updatedAt,
            })
          );
        }

        if (wineId === 'global') {
          await env.WINES_KV.put(getMindManifestKey('global'), JSON.stringify(manifest));
          if (firstShard) {
            await env.WINES_KV.put(
              getMindLatestKey('global'),
              JSON.stringify({
                key: firstShard.key,
                hash: firstShard.hash,
                targetCount: firstShard.targetCount,
                targetWineMap: firstShard.targetWineMap,
                shardId: firstShard.id,
                updatedAt,
              })
            );
          }
        }

        return json({ ok: true, manifest });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/mind/manifest' && request.method === 'GET') {
      const wineId = String(url.searchParams.get('wineId') || 'global').trim() || 'global';
      const raw = await env.WINES_KV.get(getMindManifestKey(wineId));
      if (!raw) {
        return json({ error: 'Mind manifest not found.' }, 404);
      }
      let manifest = null;
      try {
        manifest = JSON.parse(raw);
      } catch {
        return json({ error: 'Mind manifest corrupted.' }, 500);
      }
      const shards = normalizeMindShards(manifest?.shards);
      if (!shards.length) {
        return json({ error: 'Mind manifest has no shards.' }, 500);
      }

      return json({
        ready: true,
        wineId,
        updatedAt: Number.parseInt(manifest?.updatedAt, 10) || Date.now(),
        totalTargets: Number.parseInt(manifest?.totalTargets, 10) || shards.reduce((sum, shard) => sum + shard.targetCount, 0),
        shardCount: Number.parseInt(manifest?.shardCount, 10) || shards.length,
        wineShardMap: manifest?.wineShardMap && typeof manifest.wineShardMap === 'object' ? manifest.wineShardMap : {},
        shards: shards.map((shard) => ({
          id: shard.id,
          hash: shard.hash,
          key: shard.key,
          targetCount: shard.targetCount,
          targetWineMap: shard.targetWineMap,
          url: `/api/mind/file?wineId=${encodeURIComponent(wineId)}&shardId=${encodeURIComponent(shard.id)}${shard.hash ? `&v=${encodeURIComponent(shard.hash)}` : ''}`,
        })),
      });
    }

    if (url.pathname === '/api/mind/latest' && request.method === 'GET') {
      const wineId = String(url.searchParams.get('wineId') || 'global').trim() || 'global';
      const raw = await env.WINES_KV.get(getMindManifestKey(wineId));
      if (!raw) {
        return json({ error: 'Mind dataset not found.' }, 404);
      }

      let manifest = null;
      try {
        manifest = JSON.parse(raw);
      } catch {
        return json({ error: 'Mind manifest corrupted.' }, 500);
      }
      const shards = normalizeMindShards(manifest?.shards);
      const firstShard = shards[0];
      if (!firstShard) {
        return json({ error: 'Mind manifest has no shards.' }, 500);
      }
      return json({
        url: `/api/mind/file?wineId=${encodeURIComponent(wineId)}&shardId=${encodeURIComponent(firstShard.id)}${firstShard.hash ? `&v=${encodeURIComponent(firstShard.hash)}` : ''}`,
        hash: firstShard.hash || null,
        key: firstShard.key,
        shardId: firstShard.id,
        targetCount: firstShard.targetCount,
        targetWineMap: firstShard.targetWineMap,
      });
    }

    if (url.pathname === '/api/mind/file' && request.method === 'GET') {
      const wineId = String(url.searchParams.get('wineId') || 'global').trim() || 'global';
      const shardIdQuery = String(url.searchParams.get('shardId') || '').trim();
      const raw = await env.WINES_KV.get(getMindManifestKey(wineId));
      if (!raw) {
        return json({ error: 'Mind manifest not found.' }, 404);
      }

      let manifest = null;
      try {
        manifest = JSON.parse(raw);
      } catch {
        return json({ error: 'Mind manifest corrupted.' }, 500);
      }
      const shards = normalizeMindShards(manifest?.shards);
      const shard = shardIdQuery
        ? shards.find((item) => item.id === shardIdQuery)
        : shards[0];
      if (!shard) {
        return json({ error: 'Mind shard not found.' }, 404);
      }

      const key = String(shard.key || '').trim();
      const hash = String(shard.hash || '').trim();
      if (!key) {
        return json({ error: 'Mind shard metadata invalid.' }, 500);
      }

      try {
        const upstream = await fetchR2Object(env, key);
        if (!upstream.ok || !upstream.body) {
          return json({ error: `Failed to load mind dataset (${upstream.status}).` }, 502);
        }
        return new Response(upstream.body, {
          status: 200,
          headers: withRequestCorsHeaders({
            'Content-Type': 'application/octet-stream',
            'Cache-Control': hash
              ? `public, max-age=300, stale-while-revalidate=600, immutable`
              : 'public, max-age=60',
          }),
        });
      } catch (error) {
        return json({ error: error.message || 'Failed to load mind dataset.' }, 502);
      }
    }

    if (url.pathname === '/api/recognize/ocr' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const providedRaw = String(payload?.ocr_text || '').trim();
        const extracted = providedRaw
          ? { text: providedRaw, lines: [] }
          : await extractOcrDataFromImage(String(payload?.image_base64 || ''), env);
        const rawOcrText = providedRaw || extracted.text;
        const queryText = normalizeQueryText(rawOcrText);
        if (!queryText) {
          return json({ matches: [], best: null, ocr_text: '', ocr_text_raw: rawOcrText || '', ocr_lines: extracted.lines || [] });
        }

        const wines = normalizeWines(await getWines(env));
        const matches = wines
          .map((wine) => {
            const scored = scoreWineByText(wine, queryText);
            return {
              wine_id: wine.id,
              score: scored.score,
              fields_matched: scored.fieldsMatched,
            };
          })
          .filter((item) => item.score > 0.24)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        const best = matches[0] && matches[0].score >= 0.38
          ? { wine_id: matches[0].wine_id, score: matches[0].score }
          : null;

        return json({
          matches,
          best,
          ocr_text: queryText,
          ocr_text_raw: rawOcrText || '',
          ocr_lines: extracted.lines || [],
        });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/recognize/visual' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const queryEmbedding = normalizeEmbedding(payload?.embedding);
        if (!queryEmbedding.length) {
          return json({ matches: [], best: null });
        }

        const wines = normalizeWines(await getWines(env));
        const matches = wines
          .map((wine) => ({
            wine_id: wine.id,
            score_cosine: Number(cosineSimilarity(queryEmbedding, normalizeEmbedding(wine.visualEmbedding)).toFixed(5)),
          }))
          .filter((item) => item.score_cosine > 0)
          .sort((a, b) => b.score_cosine - a.score_cosine)
          .slice(0, 5);

        const best = matches[0] && matches[0].score_cosine >= 0.28
          ? { wine_id: matches[0].wine_id, score: matches[0].score_cosine }
          : null;

        return json({ matches, best });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/wines' && request.method === 'GET') {
      return json({ wines: await getWines(env) });
    }

    if (url.pathname === '/api/wines' && request.method === 'PUT') {
      const allowed = await hasAdminAccess(request, env);
      if (!allowed) {
        return json({ error: 'Unauthorized.' }, 401);
      }
      try {
        const payload = await request.json();
        if (!Array.isArray(payload?.wines)) {
          return json({ error: 'Body must contain "wines" array.' }, 400);
        }

        const normalized = payload.wines.map((wine, index) => normalizeWine(wine, index));
        normalized.forEach(validateWine);
        await saveWines(env, normalized);
        return json({ wines: normalized });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/labels/records' && request.method === 'GET') {
      const allowed = await hasAdminAccess(request, env);
      if (!allowed) {
        return json({ error: 'Unauthorized.' }, 401);
      }

      const labelIndexMap = await getLabelIndex(env);
      const entries = Object.entries(labelIndexMap)
        .map(([labelHash, targetIndex]) => ({ labelHash, targetIndex }))
        .filter((entry) => Number.isInteger(Number.parseInt(entry.targetIndex, 10)));

      const records = [];
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const record = await getLabelRecord(env, entry.labelHash);
        if (record && record.status === 'ready' && record.dataUrl) {
          records.push({
            labelHash: entry.labelHash,
            targetIndex: Number.parseInt(entry.targetIndex, 10),
            dataUrl: record.dataUrl,
            mime: record.mime || null,
            updatedAt: record.updatedAt || null,
          });
        }
      }

      records.sort((a, b) => a.targetIndex - b.targetIndex);
      return json({ records });
    }

    const wineMatch = url.pathname.match(/^\/api\/wines\/([^/]+)$/);
    if (wineMatch) {
      const wineId = decodeURIComponent(wineMatch[1]);
      const wines = await getWines(env);
      const wineIndex = wines.findIndex((wine) => wine.id === wineId);

      if (request.method === 'GET') {
        if (wineIndex === -1) {
          return json({ error: 'Wine not found.' }, 404);
        }
        return json({ wine: wines[wineIndex] });
      }

      if (request.method === 'DELETE') {
        const allowed = await hasAdminAccess(request, env);
        if (!allowed) {
          return json({ error: 'Unauthorized.' }, 401);
        }
        if (wineIndex === -1) {
          return json({ error: 'Wine not found.' }, 404);
        }
        const nextWines = wines.filter((wine) => wine.id !== wineId);
        await saveWines(env, nextWines);
        return json({ wines: nextWines });
      }

      if (request.method === 'PUT') {
        const allowed = await hasAdminAccess(request, env);
        if (!allowed) {
          return json({ error: 'Unauthorized.' }, 401);
        }
        if (wineIndex === -1) {
          return json({ error: 'Wine not found.' }, 404);
        }

        try {
          const payload = await request.json();
          const normalized = normalizeWine(payload, wineIndex);
          normalized.id = wineId;
          validateWine(normalized);

          const duplicateTarget = wines.some(
            (wine, index) => wine.targetIndex === normalized.targetIndex && index !== wineIndex
          );
          if (duplicateTarget) {
            return json({ error: 'targetIndex already used by another wine.' }, 400);
          }

          wines[wineIndex] = normalized;
          await saveWines(env, wines);
          return json({ wine: normalized });
        } catch (error) {
          return json({ error: error.message || 'Invalid request body.' }, 400);
        }
      }
    }

    if (url.pathname === '/api/wines' && request.method === 'POST') {
      const allowed = await hasAdminAccess(request, env);
      if (!allowed) {
        return json({ error: 'Unauthorized.' }, 401);
      }
      try {
        const payload = await request.json();
        const wines = await getWines(env);
        const normalized = normalizeWine(payload, wines.length);
        validateWine(normalized);

        if (wines.some((wine) => wine.id === normalized.id)) {
          return json({ error: 'Wine with this id already exists.' }, 400);
        }

        if (wines.some((wine) => wine.targetIndex === normalized.targetIndex)) {
          return json({ error: 'targetIndex already used by another wine.' }, 400);
        }

        const nextWines = [...wines, normalized];
        await saveWines(env, nextWines);
        return json({ wine: normalized }, 201);
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
