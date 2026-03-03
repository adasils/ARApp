import { AwsClient } from 'aws4fetch';

const WINES_KEY = 'wines';
const LABEL_JOB_PREFIX = 'label-job:';
const LABEL_RECORD_PREFIX = 'label-record:';
const LABEL_INDEX_KEY = 'label-index';
const TARGETS_MIND_KEY = 'targets-mind-v1';
const TARGETS_MANIFEST_KEY = 'targets-manifest-v1';
const LABEL_PROCESSING_MS = 3000;
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIND_LATEST_PREFIX = 'mind:latest:';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCorsHeaders({
      'Content-Type': 'application/json',
    }),
  });
}

function jsonWithHeaders(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCorsHeaders({
      'Content-Type': 'application/json',
      ...extraHeaders,
    }),
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) {
    return '*';
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
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
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

async function createPresignedUrl(env, { method, key, expiresIn = 600, contentType = '' }) {
  const aws = getAwsClient(env);
  const base = getR2S3Base(env);
  if (!aws || !base) {
    throw new Error('R2 credentials are not configured.');
  }
  const url = `${base}/${key}`;
  const headers = {};
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  const signed = await aws.sign(url, {
    method,
    headers,
    aws: {
      signQuery: true,
      allHeaders: true,
    },
  });
  const signedUrl = new URL(signed.url);
  signedUrl.searchParams.set('X-Amz-Expires', String(expiresIn));
  return {
    url: signedUrl.toString(),
    requiredHeaders: contentType ? { 'Content-Type': contentType } : {},
  };
}

function getMindLatestKey(wineId) {
  return `${MIND_LATEST_PREFIX}${wineId}`;
}

function normalizeWine(wine, fallbackIndex = 0) {
  const targetIndex = Number.parseInt(wine?.targetIndex, 10);
  const rating = Number.parseFloat(wine?.rating);

  return {
    id: String(wine?.id || `wine-${fallbackIndex + 1}`).trim(),
    targetIndex: Number.isInteger(targetIndex) && targetIndex >= 0 ? targetIndex : fallbackIndex,
    title: String(wine?.title || '').trim(),
    subtitle: String(wine?.subtitle || '').trim(),
    story: String(wine?.story || '').trim(),
    serving: String(wine?.serving || '').trim(),
    producer: String(wine?.producer || '').trim(),
    region: String(wine?.region || '').trim(),
    year: String(wine?.year || '').trim(),
    grapes: String(wine?.grapes || '').trim(),
    description: String(wine?.description || '').trim(),
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
  if (!wine.title || !wine.subtitle || !wine.story || !wine.serving) {
    throw new Error('Required fields: title, subtitle, story, serving.');
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

function makeJobKey(jobId) {
  return `${LABEL_JOB_PREFIX}${jobId}`;
}

async function saveLabelJob(env, job) {
  await env.WINES_KV.put(makeJobKey(job.id), JSON.stringify(job));
}

async function getLabelJob(env, jobId) {
  const raw = await env.WINES_KV.get(makeJobKey(jobId));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

async function saveLabelRecord(env, labelHash, record) {
  await env.WINES_KV.put(makeLabelRecordKey(labelHash), JSON.stringify(record));
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

async function saveLabelIndex(env, indexMap) {
  await env.WINES_KV.put(LABEL_INDEX_KEY, JSON.stringify(indexMap));
}

async function getTargetsManifest(env) {
  const raw = await env.WINES_KV.get(TARGETS_MANIFEST_KEY);
  if (!raw) {
    return {
      ready: false,
      targetCount: 0,
      signature: null,
      compiledAt: null,
      labelHashes: [],
      targetWineMap: [],
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      ready: Boolean(parsed?.ready),
      targetCount: Number.parseInt(parsed?.targetCount, 10) || 0,
      signature: parsed?.signature || null,
      compiledAt: parsed?.compiledAt || null,
      labelHashes: Array.isArray(parsed?.labelHashes) ? parsed.labelHashes : [],
      targetWineMap: normalizeTargetWineMap(parsed?.targetWineMap),
    };
  } catch {
    return {
      ready: false,
      targetCount: 0,
      signature: null,
      compiledAt: null,
      labelHashes: [],
      targetWineMap: [],
    };
  }
}

async function saveTargetsManifest(env, manifest) {
  await env.WINES_KV.put(TARGETS_MANIFEST_KEY, JSON.stringify(manifest));
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function withCorsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-admin-key',
    'Access-Control-Allow-Credentials': 'true',
  };
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

function normalizeDataUrl(labelImage) {
  const image = String(labelImage || '').trim();
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('labelImage must be a valid base64 data URL.');
  }

  const mime = match[1];
  const base64 = match[2];
  if (base64.length < 500) {
    throw new Error('labelImage looks too small.');
  }

  return { dataUrl: image, mime, base64 };
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const digestArray = Array.from(new Uint8Array(digest));
  return digestArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function extractOcrTextFromImage(dataUrl, env) {
  const apiKey = String(env.OCR_SPACE_API_KEY || '').trim();
  if (!apiKey || !dataUrl) {
    return '';
  }

  const body = new URLSearchParams();
  body.set('apikey', apiKey);
  body.set('base64Image', dataUrl);
  body.set('language', 'eng');
  body.set('isOverlayRequired', 'false');
  body.set('OCREngine', '2');

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    return '';
  }

  const payload = await response.json().catch(() => null);
  if (!payload || payload.IsErroredOnProcessing) {
    return '';
  }

  const parsed = Array.isArray(payload.ParsedResults) ? payload.ParsedResults : [];
  return parsed
    .map((item) => String(item?.ParsedText || '').trim())
    .filter(Boolean)
    .join(' ');
}

function getNextTargetIndex(labelIndexMap) {
  const used = new Set(
    Object.values(labelIndexMap || {})
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0)
  );

  let next = 0;
  while (used.has(next)) {
    next += 1;
  }
  return next;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: withCorsHeaders(),
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
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
        const targetCount = Number.parseInt(payload?.targetCount, 10) || 0;
        const targetWineMap = normalizeTargetWineMap(payload?.targetWineMap);
        if (!hash) {
          return json({ error: 'hash is required.' }, 400);
        }

        const key = `mind/${wineId}/${hash}.mind`;
        const presigned = await createPresignedUrl(env, {
          method: 'PUT',
          key,
          expiresIn: 600,
          contentType: 'application/octet-stream',
        });

        await env.WINES_KV.put(
          getMindLatestKey(wineId),
          JSON.stringify({
            key,
            hash,
            targetCount,
            targetWineMap,
            updatedAt: Date.now(),
          })
        );

        if (wineId === 'global') {
          await env.WINES_KV.put(
            getMindLatestKey('global'),
            JSON.stringify({
              key,
              hash,
              targetCount,
              targetWineMap,
              updatedAt: Date.now(),
            })
          );
        }

        return json({
          putUrl: presigned.url,
          key,
          requiredHeaders: presigned.requiredHeaders,
        });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    if (url.pathname === '/api/mind/latest' && request.method === 'GET') {
      const wineId = String(url.searchParams.get('wineId') || 'global').trim() || 'global';
      const raw = await env.WINES_KV.get(getMindLatestKey(wineId));
      if (!raw) {
        return json({ error: 'Mind dataset not found.' }, 404);
      }
      let latest = null;
      try {
        latest = JSON.parse(raw);
      } catch {
        return json({ error: 'Mind metadata corrupted.' }, 500);
      }

      const key = String(latest?.key || '').trim();
      const hash = String(latest?.hash || '').trim();
      const targetCount = Number.parseInt(latest?.targetCount, 10) || 0;
      const targetWineMap = normalizeTargetWineMap(latest?.targetWineMap);
      if (!key) {
        return json({ error: 'Mind metadata invalid.' }, 500);
      }

      const publicBase = getR2PublicBase(env);
      if (publicBase) {
        return json({
          url: `${publicBase}/${key}?v=${encodeURIComponent(hash || Date.now())}`,
          hash: hash || null,
          key,
          targetCount,
          targetWineMap,
        });
      }

      const presigned = await createPresignedUrl(env, {
        method: 'GET',
        key,
        expiresIn: 1800,
      });
      const suffix = hash ? `${presigned.url.includes('?') ? '&' : '?'}v=${encodeURIComponent(hash)}` : '';
      return json({
        url: `${presigned.url}${suffix}`,
        hash: hash || null,
        key,
        targetCount,
        targetWineMap,
      });
    }

    if (url.pathname === '/api/mind/dataset' && request.method === 'GET') {
      const manifest = await getTargetsManifest(env);
      return json({
        ready: Boolean(manifest?.ready),
        targetCount: Number.parseInt(manifest?.targetCount, 10) || 0,
        compiledAt: manifest?.compiledAt || null,
        mindUrl: manifest?.ready ? `${url.origin}/targets/mind` : null,
      });
    }

    if (url.pathname === '/api/recognize/ocr' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const provided = normalizeQueryText(payload?.ocr_text || '');
        const fallbackOcr = provided
          ? ''
          : normalizeQueryText(await extractOcrTextFromImage(String(payload?.image_base64 || ''), env));
        const queryText = provided || fallbackOcr;
        if (!queryText) {
          return json({ matches: [], best: null });
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

        return json({ matches, best, ocr_text: queryText });
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

    const apiWineMatch = url.pathname.match(/^\/api\/wines\/([^/]+)$/);
    if (apiWineMatch && request.method === 'GET') {
      const wineId = decodeURIComponent(apiWineMatch[1]);
      const wines = normalizeWines(await getWines(env));
      const wine = wines.find((item) => item.id === wineId) || null;
      if (!wine) {
        return json({ error: 'Wine not found.' }, 404);
      }
      return json({ wine });
    }

    if (url.pathname === '/wines' && request.method === 'GET') {
      return json({ wines: await getWines(env) });
    }

    if (url.pathname === '/wines' && request.method === 'PUT') {
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

    if (url.pathname === '/labels/records' && request.method === 'GET') {
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

    if (url.pathname === '/labels/process' && request.method === 'POST') {
      const allowed = await hasAdminAccess(request, env);
      if (!allowed) {
        return json({ error: 'Unauthorized.' }, 401);
      }
      try {
        const payload = await request.json();
        const { dataUrl, mime, base64 } = normalizeDataUrl(payload?.labelImage);
        const labelHash = await sha256Hex(base64);
        const existingRecord = await getLabelRecord(env, labelHash);
        if (existingRecord && existingRecord.status === 'ready') {
          const existingJob = {
            id: crypto.randomUUID(),
            status: 'ready',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            targetIndex: existingRecord.targetIndex,
            wineId: String(payload?.wineId || '').trim() || null,
            labelHash,
            deduplicated: true,
            error: null,
          };
          await saveLabelJob(env, existingJob);
          return json({ job: existingJob }, 200);
        }

        const labelIndexMap = await getLabelIndex(env);
        const indexedTarget = Number.parseInt(labelIndexMap[labelHash], 10);
        const recordTarget = Number.parseInt(existingRecord?.targetIndex, 10);
        const targetIndex = Number.isInteger(indexedTarget) && indexedTarget >= 0
          ? indexedTarget
          : Number.isInteger(recordTarget) && recordTarget >= 0
            ? recordTarget
            : getNextTargetIndex(labelIndexMap);

        const job = {
          id: crypto.randomUUID(),
          status: 'processing',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          targetIndex,
          wineId: String(payload?.wineId || '').trim() || null,
          labelHash,
          deduplicated: false,
          error: null,
        };

        const labelRecord = {
          status: 'processing',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          targetIndex,
          mime,
          labelHash,
          dataUrl,
        };

        await saveLabelJob(env, job);
        await saveLabelRecord(env, labelHash, labelRecord);
        return json({ job }, 202);
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    const jobMatch = url.pathname.match(/^\/labels\/process\/([^/]+)$/);
    if (jobMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(jobMatch[1]);
      const job = await getLabelJob(env, jobId);
      if (!job) {
        return json({ error: 'Job not found.' }, 404);
      }

      if (
        job.status === 'processing' &&
        Number.isFinite(job.createdAt) &&
        Date.now() - job.createdAt >= LABEL_PROCESSING_MS
      ) {
        job.status = 'ready';
        job.updatedAt = Date.now();
        await saveLabelJob(env, job);

        if (job.labelHash) {
          const record = await getLabelRecord(env, job.labelHash);
          if (record) {
            record.status = 'ready';
            record.updatedAt = Date.now();
            await saveLabelRecord(env, job.labelHash, record);
          }

          const labelIndexMap = await getLabelIndex(env);
          labelIndexMap[job.labelHash] = job.targetIndex;
          await saveLabelIndex(env, labelIndexMap);
        }
      }

      return json({ job });
    }

    if (url.pathname === '/targets/manifest' && request.method === 'GET') {
      const manifest = await getTargetsManifest(env);
      return json({ manifest });
    }

    if (url.pathname === '/targets/mind' && request.method === 'GET') {
      const mindBase64 = await env.WINES_KV.get(TARGETS_MIND_KEY);
      if (!mindBase64) {
        return json({ error: 'Compiled targets not found.' }, 404);
      }

      return new Response(fromBase64(mindBase64), {
        status: 200,
        headers: withCorsHeaders({
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=30',
        }),
      });
    }

    if (url.pathname === '/targets/mind' && request.method === 'PUT') {
      const allowed = await hasAdminAccess(request, env);
      if (!allowed) {
        return json({ error: 'Unauthorized.' }, 401);
      }

      try {
        const payload = await request.json();
        const mindBase64 = String(payload?.mindBase64 || '').trim();
        const labelHashes = Array.isArray(payload?.labelHashes)
          ? payload.labelHashes.map((hash) => String(hash || '').trim()).filter(Boolean)
          : [];
        const signature = String(payload?.signature || '').trim() || null;
        const targetCount = Number.parseInt(payload?.targetCount, 10) || 0;
        const targetWineMap = normalizeTargetWineMap(payload?.targetWineMap);

        if (!mindBase64) {
          return json({ error: 'mindBase64 is required.' }, 400);
        }

        await env.WINES_KV.put(TARGETS_MIND_KEY, mindBase64);
        await saveTargetsManifest(env, {
          ready: true,
          targetCount,
          signature,
          labelHashes,
          targetWineMap,
          compiledAt: Date.now(),
        });
        return json({ ok: true });
      } catch (error) {
        return json({ error: error.message || 'Invalid request body.' }, 400);
      }
    }

    const wineMatch = url.pathname.match(/^\/wines\/([^/]+)$/);
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

    if (url.pathname === '/wines' && request.method === 'POST') {
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
