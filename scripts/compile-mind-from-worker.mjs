import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';
import { loadImage } from 'canvas';

const apiBase = String(process.env.WORKER_API_BASE || '').trim().replace(/\/$/, '');
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
    .map((record) => `${record.targetIndex}:${record.labelHash}`)
    .join('|');
}

async function main() {
  const [{ records }, { manifest }] = await Promise.all([
    apiGet('/labels/records'),
    fetch(`${apiBase}/targets/manifest`).then((r) => r.json()).catch(() => ({ manifest: null })),
  ]);

  if (!Array.isArray(records) || records.length === 0) {
    console.log('No ready label records found. Skip compilation.');
    return;
  }

  const orderedRecords = [...records].sort((a, b) => a.targetIndex - b.targetIndex);
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
    labelHashes: orderedRecords.map((record) => record.labelHash),
  });

  console.log(`Compiled ${orderedRecords.length} labels and uploaded targets.mind`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
