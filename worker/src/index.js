const WINES_KEY = 'wines';
const LABEL_JOB_PREFIX = 'label-job:';
const LABEL_PROCESSING_MS = 3000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
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
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, Number(rating.toFixed(1)))) : 0,
    labelImage: String(wine?.labelImage || '').trim(),
    pairings: Array.isArray(wine?.pairings) ? wine.pairings.map((x) => String(x || '').trim()).filter(Boolean) : [],
    gallery: Array.isArray(wine?.gallery) ? wine.gallery.map((x) => String(x || '').trim()).filter(Boolean) : [],
  };
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true });
    }

    if (url.pathname === '/wines' && request.method === 'GET') {
      return json({ wines: await getWines(env) });
    }

    if (url.pathname === '/wines' && request.method === 'PUT') {
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

    if (url.pathname === '/labels/process' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const labelImage = String(payload?.labelImage || '').trim();
        if (!labelImage) {
          return json({ error: 'labelImage is required.' }, 400);
        }

        const wines = await getWines(env);
        const requestedTargetIndex = Number.parseInt(payload?.targetIndex, 10);
        const nextTargetIndex = wines.length
          ? wines.reduce((max, wine) => Math.max(max, Number.parseInt(wine.targetIndex, 10) || 0), 0) + 1
          : 0;

        const targetIndex = Number.isInteger(requestedTargetIndex) && requestedTargetIndex >= 0
          ? requestedTargetIndex
          : nextTargetIndex;

        const job = {
          id: crypto.randomUUID(),
          status: 'processing',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          targetIndex,
          wineId: String(payload?.wineId || '').trim() || null,
          error: null,
        };

        await saveLabelJob(env, job);
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
      }

      return json({ job });
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
        if (wineIndex === -1) {
          return json({ error: 'Wine not found.' }, 404);
        }
        const nextWines = wines.filter((wine) => wine.id !== wineId);
        await saveWines(env, nextWines);
        return json({ wines: nextWines });
      }

      if (request.method === 'PUT') {
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
