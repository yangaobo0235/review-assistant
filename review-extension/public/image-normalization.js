/**
 * 功能：把图片转换为尺寸和容量受控的 JPEG。
 * 职责边界：不放大小图，失败时返回明确错误。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

(() => {
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
  const MAX_DIMENSION = 2048;
  const JPEG_QUALITY = 0.85;
  let normalizationQueue = Promise.resolve();

  const calculateTargetSize = (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("图片尺寸无效");
    }
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    return [
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale))
    ];
  };

  const normalizeBlobNow = async (blob, dependencies) => {
    const decode = dependencies.createImageBitmap || globalThis.createImageBitmap;
    let bitmap;
    try {
      bitmap = await decode(blob);
    } catch {
      throw new Error("图片解码失败");
    }

    try {
      const [width, height] = calculateTargetSize(bitmap.width, bitmap.height);
      const createCanvas = dependencies.createCanvas
        || ((canvasWidth, canvasHeight) => new globalThis.OffscreenCanvas(canvasWidth, canvasHeight));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-context-unavailable");
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      bitmap = null;
      const output = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: JPEG_QUALITY
      });
      if (!(output instanceof globalThis.Blob) || output.type !== "image/jpeg") {
        throw new Error("invalid-output");
      }
      if (output.size > MAX_OUTPUT_BYTES) {
        throw new Error("图片压缩后仍超过 5 MB 限制");
      }
      return output;
    } catch (error) {
      if (error instanceof Error && error.message === "图片压缩后仍超过 5 MB 限制") {
        throw error;
      }
      throw new Error("图片压缩失败");
    } finally {
      bitmap?.close?.();
    }
  };

  const normalizeBlob = (blob, dependencies = {}) => {
    if (!(blob instanceof globalThis.Blob) || !Number.isFinite(blob.size) || blob.size < 0) {
      return Promise.reject(new Error("图片读取失败"));
    }
    if (blob.size > MAX_SOURCE_BYTES) {
      return Promise.reject(new Error("图片超过 20 MB 原始文件限制"));
    }

    const task = normalizationQueue.then(() => normalizeBlobNow(blob, dependencies));
    normalizationQueue = task.catch(() => undefined);
    return task;
  };

  const readResponseBlobWithLimit = async (response) => {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
      throw new Error("图片超过 20 MB 原始文件限制");
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("图片读取失败");
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_SOURCE_BYTES) {
          await reader.cancel();
          throw new Error("图片超过 20 MB 原始文件限制");
        }
        chunks.push(value);
      }
      const mimeType = response.headers?.get?.("content-type") || "application/octet-stream";
      return new globalThis.Blob(chunks, { type: mimeType });
    } finally {
      reader.releaseLock?.();
    }
  };

  globalThis.ReviewImageNormalization = {
    MAX_SOURCE_BYTES,
    MAX_OUTPUT_BYTES,
    MAX_DIMENSION,
    JPEG_QUALITY,
    calculateTargetSize,
    normalizeBlob,
    readResponseBlobWithLimit
  };
})();
