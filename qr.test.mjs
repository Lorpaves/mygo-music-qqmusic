import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jpeg from 'jpeg-js';
import { decodeQR } from './qr.js';

test('decodes a PNG QR code', async () => {
  const text = 'https://example.org/login?id=123';
  const image = await QRCode.toBuffer(text, { width: 256, margin: 4 });
  assert.equal(await decodeQR(image), text);
});

test('decodes a JPEG QR code', async () => {
  const text = 'https://example.org/login?id=456';
  const code = QRCode.create(text), scale = 6, margin = 4;
  const width = (code.modules.size + margin * 2) * scale;
  const pixels = Buffer.alloc(width * width * 4, 255);
  for (let y = 0; y < code.modules.size; y++) for (let x = 0; x < code.modules.size; x++) {
    if (!code.modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
    }
  }
  assert.equal(await decodeQR(jpeg.encode({ data: pixels, width, height: width }, 90).data), text);
});

test('rejects unsupported image data', async () => {
  await assert.rejects(decodeQR(new Uint8Array([1, 2, 3])), /Unsupported/);
});
