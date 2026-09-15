import assert from "node:assert/strict";
import test from "node:test";
import { ReviewImageNormalization } from "../src/browser/image-normalization.ts";

function loadNormalization() {
  return ReviewImageNormalization;
}

class SizedBlob extends Blob {
  constructor(size, options = {}) {
    super([], options);
    this.testSize = size;
  }

  get size() {
    return this.testSize;
  }
}

test("scales landscape and portrait images to a 2048 pixel maximum edge", () => {
  const { calculateTargetSize } = loadNormalization();

  assert.deepEqual(Array.from(calculateTargetSize(4096, 2048)), [2048, 1024]);
  assert.deepEqual(Array.from(calculateTargetSize(1200, 2400)), [1024, 2048]);
});

test("does not enlarge images already within the maximum dimensions", () => {
  const { calculateTargetSize } = loadNormalization();

  assert.deepEqual(Array.from(calculateTargetSize(1280, 960)), [1280, 960]);
});

test("normalizes an image as a quality 0.85 JPEG and closes its bitmap", async () => {
  const { normalizeBlob } = loadNormalization();
  let canvasSize;
  let convertOptions;
  let drawnSize;
  let bitmapClosed = false;
  const bitmap = {
    width: 4096,
    height: 2048,
    close: () => {
      bitmapClosed = true;
    },
  };
  const outputBlob = new SizedBlob(400_000, { type: "image/jpeg" });

  const result = await normalizeBlob(
    new SizedBlob(8 * 1024 * 1024),
    {
      createImageBitmap: async () => bitmap,
      createCanvas: (width, height) => {
        canvasSize = [width, height];
        return {
          getContext: () => ({
            drawImage: (_bitmap, _x, _y, drawWidth, drawHeight) => {
              drawnSize = [drawWidth, drawHeight];
            },
          }),
          convertToBlob: async (options) => {
            convertOptions = options;
            return outputBlob;
          },
        };
      },
    },
  );

  assert.equal(result, outputBlob);
  assert.deepEqual(canvasSize, [2048, 1024]);
  assert.deepEqual(drawnSize, [2048, 1024]);
  assert.deepEqual({ ...convertOptions }, { type: "image/jpeg", quality: 0.85 });
  assert.equal(bitmapClosed, true);
});

test("rejects source images above 20 MB before decoding", async () => {
  const { normalizeBlob } = loadNormalization();
  let decoded = false;

  await assert.rejects(
    normalizeBlob(
      new SizedBlob(20 * 1024 * 1024 + 1),
      { createImageBitmap: async () => { decoded = true; } },
    ),
    /图片超过 20 MB 原始文件限制/,
  );
  assert.equal(decoded, false);
});

test("rejects JPEG output above 5 MB and closes the bitmap", async () => {
  const { normalizeBlob } = loadNormalization();
  let bitmapClosed = false;

  await assert.rejects(
    normalizeBlob(
      new SizedBlob(10 * 1024 * 1024),
      {
        createImageBitmap: async () => ({
          width: 2048,
          height: 2048,
          close: () => { bitmapClosed = true; },
        }),
        createCanvas: () => ({
          getContext: () => ({ drawImage: () => {} }),
          convertToBlob: async () => new SizedBlob(
            5 * 1024 * 1024 + 1,
            { type: "image/jpeg" },
          ),
        }),
      },
    ),
    /图片压缩后仍超过 5 MB 限制/,
  );
  assert.equal(bitmapClosed, true);
});

test("reports decode failures without exposing low-level details", async () => {
  const { normalizeBlob } = loadNormalization();

  await assert.rejects(
    normalizeBlob(
      new SizedBlob(1000),
      { createImageBitmap: async () => { throw new Error("sensitive decoder detail"); } },
    ),
    /^Error: 图片解码失败$/,
  );
});

test("reports compression failures and still closes the bitmap", async () => {
  const { normalizeBlob } = loadNormalization();
  let bitmapClosed = false;

  await assert.rejects(
    normalizeBlob(
      new SizedBlob(1000),
      {
        createImageBitmap: async () => ({
          width: 100,
          height: 100,
          close: () => { bitmapClosed = true; },
        }),
        createCanvas: () => ({ getContext: () => null }),
      },
    ),
    /^Error: 图片压缩失败$/,
  );
  assert.equal(bitmapClosed, true);
});

test("rejects non-Blob inputs before decoding", async () => {
  const { normalizeBlob } = loadNormalization();
  let decoded = false;

  await assert.rejects(
    normalizeBlob(
      { size: 1000 },
      { createImageBitmap: async () => { decoded = true; } },
    ),
    /图片读取失败/,
  );
  assert.equal(decoded, false);
});

test("serializes image normalization to bound decoded bitmap memory", async () => {
  const { normalizeBlob } = loadNormalization();
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let decodedCount = 0;
  const dependencies = {
    createImageBitmap: async () => {
      decodedCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (decodedCount === 1) await firstRelease;
      return { width: 100, height: 100, close: () => { active -= 1; } };
    },
    createCanvas: () => ({
      getContext: () => ({ drawImage: () => {} }),
      convertToBlob: async () => new SizedBlob(100, { type: "image/jpeg" }),
    }),
  };

  const first = normalizeBlob(new SizedBlob(1000), dependencies);
  const second = normalizeBlob(new SizedBlob(1000), dependencies);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(decodedCount, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test("streams HTTP image bodies and cancels once they exceed 20 MB", async () => {
  const { readResponseBlobWithLimit } = loadNormalization();
  const chunks = [
    new Uint8Array(12 * 1024 * 1024),
    new Uint8Array(9 * 1024 * 1024),
  ];
  let cancelled = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => chunks.length
          ? { done: false, value: chunks.shift() }
          : { done: true },
        cancel: async () => { cancelled = true; },
      }),
    },
  };

  await assert.rejects(
    readResponseBlobWithLimit(response),
    /图片超过 20 MB 原始文件限制/,
  );
  assert.equal(cancelled, true);
});

test("rejects oversized HTTP content length before reading the body", async () => {
  const { readResponseBlobWithLimit } = loadNormalization();
  let readerCreated = false;
  const response = {
    headers: { get: () => String(20 * 1024 * 1024 + 1) },
    body: { getReader: () => { readerCreated = true; } },
  };

  await assert.rejects(
    readResponseBlobWithLimit(response),
    /图片超过 20 MB 原始文件限制/,
  );
  assert.equal(readerCreated, false);
});
