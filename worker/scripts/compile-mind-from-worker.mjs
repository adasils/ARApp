import crypto from 'node:crypto';
import { CanvasElement, Image, ImageData, createCanvas, loadImage } from 'canvas';
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';

const API_BASE_URL = String(process.env.API_BASE_URL || 'https://vinoria.app').replace(/\/+$/, '');
const TARGETS_ADMIN_KEY = String(process.env.TARGETS_ADMIN_KEY || '').trim();
const WINE_ID = String(process.env.MIND_WINE_ID || 'global').trim() || 'global';
const SHARD_SIZE = Math.max(1, Number.parseInt(process.env.MIND_SHARD_SIZE || '80', 10) || 80);

if (!TARGETS_ADMIN_KEY) {
  throw new Error('TARGETS_ADMIN_KEY is required.');
}

if (!globalThis.document) {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return createCanvas(1, 1);
      }
      throw new Error(`Unsupported document.createElement(${tag}) in Node compiler.`);
    },
  };
}

// MindAR compiler checks browser-like classes via `instanceof`.
if (!globalThis.HTMLCanvasElement) {
  globalThis.HTMLCanvasElement = CanvasElement;
}
if (!globalThis.HTMLImageElement) {
  globalThis.HTMLImageElement = Image;
}
if (!globalThis.Image) {
  globalThis.Image = Image;
}
if (!globalThis.ImageData) {
  globalThis.ImageData = ImageData;
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Invalid label image data URL.');
  }
  return Buffer.from(match[1], 'base64');
}

async function apiGet(path, withAdmin = false) {
  const headers = {
    'Accept': 'application/json',
  };
  if (withAdmin) {
    headers['x-admin-key'] = TARGETS_ADMIN_KEY;
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `GET ${path} failed: ${response.status}`);
  }
  return payload;
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'x-admin-key': TARGETS_ADMIN_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `POST ${path} failed: ${response.status}`);
  }
  return payload;
}

function normalizeRecordsFromWines(wines) {
  const normalizedWines = Array.isArray(wines) ? wines : [];
  const rows = [];
  normalizedWines.forEach((wine) => {
    const wineId = String(wine?.id || '').trim();
    if (!wineId) {
      return;
    }
    const assets = Array.isArray(wine?.labelAssets) ? wine.labelAssets : [];
    if (assets.length) {
      assets.forEach((asset) => {
        const dataUrl = String(asset?.dataUrl || '').trim();
        if (!dataUrl) {
          return;
        }
        const role = String(asset?.role || 'front').trim() || 'front';
        const hash = crypto.createHash('sha256').update(dataUrl).digest('hex');
        rows.push({
          labelHash: hash,
          targetIndex: Number.parseInt(wine?.targetIndex, 10) || 0,
          dataUrl,
          wineId,
          role,
        });
      });
      return;
    }
    const legacyDataUrl = String(wine?.labelImage || '').trim();
    if (!legacyDataUrl) {
      return;
    }
    const hash = crypto.createHash('sha256').update(legacyDataUrl).digest('hex');
    rows.push({
      labelHash: hash,
      targetIndex: Number.parseInt(wine?.targetIndex, 10) || 0,
      dataUrl: legacyDataUrl,
      wineId,
      role: 'front',
    });
  });
  return rows.sort((a, b) => a.targetIndex - b.targetIndex);
}

async function compileShard(shardItems, shardIndex, shardCount) {
  const compiler = new OfflineCompiler();
  const images = [];
  for (let i = 0; i < shardItems.length; i += 1) {
    const imageBuffer = dataUrlToBuffer(shardItems[i].dataUrl);
    const loaded = await loadImage(imageBuffer);
    const canvas = createCanvas(loaded.width, loaded.height);
    const context = canvas.getContext('2d');
    context.drawImage(loaded, 0, 0, loaded.width, loaded.height);
    images.push(canvas);
  }
  await compiler.compileImageTargets(images, (progress) => {
    const p = Number.parseInt(progress, 10) || 0;
    process.stdout.write(`\rcompile shard ${shardIndex + 1}/${shardCount}: ${p}%   `);
  });
  process.stdout.write('\n');
  const compiled = compiler.exportData();
  if (compiled instanceof ArrayBuffer) {
    return new Uint8Array(compiled);
  }
  if (ArrayBuffer.isView(compiled)) {
    return new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength);
  }
  throw new Error('OfflineCompiler returned invalid binary.');
}

async function uploadShardBinary(bytes, shardId, hash) {
  const presign = await apiPost('/api/admin/mind/presign-put', {
    wineId: WINE_ID,
    shardId,
    hash,
  });
  const putResponse = await fetch(presign.putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(presign.requiredHeaders || {}),
    },
    body: bytes,
  });
  if (!putResponse.ok) {
    throw new Error(`R2 upload failed for ${shardId}: ${putResponse.status}`);
  }
  return {
    id: shardId,
    key: presign.key,
  };
}

async function main() {
  const payload = await apiGet('/api/wines');
  const records = normalizeRecordsFromWines(payload?.wines);
  if (!records.length) {
    console.log('No label records to compile.');
    return;
  }

  const shards = chunkArray(records, SHARD_SIZE);
  const builtShards = [];

  for (let index = 0; index < shards.length; index += 1) {
    const shardItems = shards[index];
    const shardId = `shard-${index}`;
    const bytes = await compileShard(shardItems, index, shards.length);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const uploaded = await uploadShardBinary(bytes, shardId, hash);
    builtShards.push({
      id: shardId,
      key: uploaded.key,
      hash,
      targetCount: shardItems.length,
      targetWineMap: shardItems.map((item) => ({
        wineId: item.wineId || `target-${item.targetIndex}`,
        role: item.role || 'front',
        assetHash: item.labelHash,
      })),
    });
    console.log(`uploaded ${shardId}: ${shardItems.length} targets`);
  }

  await apiPost('/api/admin/mind/finalize', {
    wineId: WINE_ID,
    shards: builtShards,
    updatedAt: Date.now(),
  });
  const total = builtShards.reduce((sum, shard) => sum + shard.targetCount, 0);
  console.log(`Compiled ${total} labels into ${builtShards.length} shard(s) and finalized manifest.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
