import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';
import { loadImage } from 'canvas';
import crypto from 'node:crypto';

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    return new URL(withProtocol).toString().replace(/\/$/, '');
  } catch {
    throw new Error(
      'WORKER_API_BASE must be a valid URL, for example: https://wine-label-api.<subdomain>.workers.dev'
    );
  }
}

const apiBase = normalizeApiBase(process.env.WORKER_API_BASE);
const adminKey = String(process.env.TARGETS_ADMIN_KEY || '').trim();

if (!apiBase) {
  throw new Error('WORKER_API_BASE is required');
}
if (!adminKey) {
  throw new Error('TARGETS_ADMIN_KEY is required');
}

async function apiGet(path) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      'x-admin-key': adminKey,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `GET ${path} failed: ${response.status}`);
  }
  return payload;
}

async function apiPut(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': adminKey,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `PUT ${path} failed: ${response.status}`);
  }
  return payload;
}

function toBase64(uint8Array) {
  return Buffer.from(uint8Array).toString('base64');
}

function buildSignature(records) {
  return records
    .map((record) => `${record.wineId}:${record.role}:${record.assetHash}`)
    .join('|');
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return value || 'alt';
}

function buildRecordsFromWines(wines) {
  const records = [];
  (wines || []).forEach((wine) => {
    const wineId = String(wine?.id || '').trim();
    if (!wineId) {
      return;
    }
    const assets = Array.isArray(wine?.labelAssets) ? wine.labelAssets : [];
    const sourceAssets = assets.length
      ? assets
      : (String(wine?.labelImage || '').trim().startsWith('data:image/')
        ? [{ role: 'front', dataUrl: String(wine.labelImage).trim() }]
        : []);

    sourceAssets.forEach((asset, index) => {
      const dataUrl = String(asset?.dataUrl || '').trim();
      if (!dataUrl.startsWith('data:image/')) {
        return;
      }
      const role = normalizeRole(asset?.role) || `asset-${index + 1}`;
      const assetHash = crypto.createHash('sha256').update(dataUrl).digest('hex');
      records.push({
        wineId,
        role,
        dataUrl,
        assetHash,
      });
    });
  });

  return records;
}

async function main() {
  const [{ wines }, { manifest }] = await Promise.all([
    apiGet('/wines'),
    fetch(`${apiBase}/targets/manifest`).then((r) => r.json()).catch(() => ({ manifest: null })),
  ]);

  const sourceRecords = buildRecordsFromWines(wines);

  if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) {
    console.log('No label assets found in wines. Skip compilation.');
    return;
  }

  const orderedRecords = [...sourceRecords].sort((a, b) => {
    if (a.wineId !== b.wineId) {
      return a.wineId.localeCompare(b.wineId);
    }
    return a.role.localeCompare(b.role);
  });
  const signature = buildSignature(orderedRecords);

  if (manifest?.manifest?.ready && manifest.manifest.signature === signature) {
    console.log('Signature unchanged, compiled target is up to date.');
    return;
  }

  const images = [];
  for (let i = 0; i < orderedRecords.length; i += 1) {
    const record = orderedRecords[i];
    const image = await loadImage(record.dataUrl);
    images.push(image);
  }

  const compiler = new OfflineCompiler();
  await compiler.compileImageTargets(images, (progress) => {
    if (Math.round(progress) % 20 === 0) {
      console.log(`compile progress: ${Math.round(progress)}%`);
    }
  });

  const compiled = compiler.exportData();
  const mindBase64 = toBase64(compiled);

  await apiPut('/targets/mind', {
    mindBase64,
    signature,
    targetCount: orderedRecords.length,
    labelHashes: orderedRecords.map((record) => record.assetHash),
    targetWineMap: orderedRecords.map((record) => ({
      wineId: record.wineId,
      role: record.role,
      assetHash: record.assetHash,
    })),
  });

  console.log(`Compiled ${orderedRecords.length} label assets and uploaded targets.mind`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
