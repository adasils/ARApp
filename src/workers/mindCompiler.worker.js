async function loadBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

let OfflineCompilerRef = null;
async function getOfflineCompiler() {
  if (OfflineCompilerRef) {
    return OfflineCompilerRef;
  }
  const mod = await import(
    /* @vite-ignore */
    'https://esm.sh/mind-ar@1.2.5/src/image-target/offline-compiler.js'
  );
  OfflineCompilerRef = mod.OfflineCompiler;
  return OfflineCompilerRef;
}

self.onmessage = async (event) => {
  const { type, images } = event.data || {};
  if (type !== 'compile') {
    return;
  }

  try {
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('No images to compile.');
    }

    const bitmaps = [];
    for (let i = 0; i < images.length; i += 1) {
      bitmaps.push(await loadBitmap(images[i]));
    }

    const OfflineCompiler = await getOfflineCompiler();
    const compiler = new OfflineCompiler();
    await compiler.compileImageTargets(bitmaps, (progress) => {
      self.postMessage({
        type: 'progress',
        progress: Math.round(progress),
      });
    });

    const compiled = compiler.exportData();
    let bytes = null;
    if (compiled instanceof ArrayBuffer) {
      bytes = new Uint8Array(compiled);
    } else if (ArrayBuffer.isView(compiled)) {
      bytes = new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength);
    } else {
      throw new Error('Compiler returned invalid dataset buffer.');
    }
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    self.postMessage(
      {
        type: 'done',
        buffer: output.buffer,
      },
      [output.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error?.message || 'Compilation failed.',
    });
  }
};
