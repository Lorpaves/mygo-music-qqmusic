import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Exercise both the source and the standalone bundle shipped to MyGo.
for (const entry of ['./index.js', './dist/index.js']) {
  const plugin = await import(entry);
  describe(`stream fallback: ${entry}`, () => {
    const mid = 'fixturemid', authKey = 'qqmusic.auth.v1';
    const session = { musicid: '12345', musickey: 'fixture-key', loginType: 1 };
    const storage = new Map();
    let attempts, respond;
    const rpc = data => Response.json({ code: 0, req_0: { code: 0, data } });
    const playable = () => rpc({ sip: ['https://isure.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: mid, purl: 'fixture.mp3' }] });
    const empty = () => rpc({ midurlinfo: [] });
    const http = status => new Response('', { status });
    beforeEach(() => {
      globalThis.host = { t: x => x, storage: {
        get: k => storage.get(k), set: (k, v) => storage.set(k, v), remove: k => storage.delete(k),
      } };
      plugin.signOut(); storage.clear(); storage.set(authKey, session);
      attempts = [];
      respond = () => { throw new Error('Unexpected vkey request'); };
      globalThis.fetch = async (_url, options) => {
        const { method, param } = JSON.parse(options.body).req_0;
        if (method === 'get_song_detail_yqq') return rpc({ track_info: { mid, file: {
          media_mid: mid, size_128mp3: 128, size_320mp3: 320, size_flac: 1000,
        } } });
        assert.equal(method, 'UrlGetVkey');
        const prefix = param.filename[0].slice(0, 4);
        attempts.push(prefix);
        return respond(prefix);
      };
    });

    test('FLAC HTTP 503 falls back to MP3 high and reports actual quality and size', async () => {
      respond = prefix => prefix === 'F000' ? http(503) : playable();
      const result = await plugin.stream({ id: mid, quality: 'lossless' });
      assert.deepEqual(attempts, ['F000', 'M800']);
      assert.equal(result.quality, 'high'); assert.equal(result.type, 'mp3'); assert.equal(result.size, 320);
      assert.deepEqual(storage.get(authKey), session);
    });

    test('high HTTP 502 falls back to standard without trying FLAC', async () => {
      respond = prefix => prefix === 'M800' ? http(502) : playable();
      const result = await plugin.stream({ id: mid, quality: 'high' });
      assert.deepEqual(attempts, ['M800', 'M500']);
      assert.equal(result.quality, 'standard'); assert.equal(result.size, 128);
    });

    test('HTTP 500 and 504 fall back through both higher qualities', async () => {
      respond = prefix => prefix === 'F000' ? http(500) : prefix === 'M800' ? http(504) : playable();
      assert.equal((await plugin.stream({ id: mid, quality: 'lossless' })).quality, 'standard');
      assert.deepEqual(attempts, ['F000', 'M800', 'M500']);
    });

    test('exhausted server errors preserve the last error and stop after three attempts', async () => {
      respond = prefix => http(prefix === 'M500' ? 504 : 503);
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), { message: 'QQ Music HTTP 504', qqHttpStatus: 504 });
      assert.deepEqual(attempts, ['F000', 'M800', 'M500']);
    });

    test('empty lower-quality replies do not hide an earlier HTTP failure', async () => {
      respond = prefix => prefix === 'F000' ? http(503) : empty();
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), { qqHttpStatus: 503 });
      assert.deepEqual(attempts, ['F000', 'M800', 'M500']);
    });

    test('standard-quality failures are not retried', async () => {
      respond = () => http(503);
      await assert.rejects(plugin.stream({ id: mid, quality: 'standard' }), { qqHttpStatus: 503 });
      assert.deepEqual(attempts, ['M500']);
    });

    for (const status of [401, 403, 429]) test(`HTTP ${status} stops fallback even after a server error`, async () => {
      respond = prefix => http(prefix === 'F000' ? 503 : status);
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), { qqHttpStatus: status });
      assert.deepEqual(attempts, ['F000', 'M800']);
    });

    test('invalid login business codes stop fallback', async () => {
      respond = () => Response.json({ code: 0, req_0: { code: 104401 } });
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), /104401/);
      assert.deepEqual(attempts, ['F000']);
    });

    for (const name of ['AbortError', 'TypeError']) test(`${name} propagates unchanged without fallback`, async () => {
      const error = new Error('Fixture transport failure: HTTP 503'); error.name = name;
      respond = () => { throw error; };
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), e => e === error);
      assert.deepEqual(attempts, ['F000']);
    });

    test('malformed JSON is not treated as a recoverable server failure', async () => {
      respond = () => new Response('{broken');
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), SyntaxError);
      assert.deepEqual(attempts, ['F000']);
    });

    test('invalid stream hosts are rejected without trying another quality', async () => {
      respond = () => rpc({ midurlinfo: [{ songmid: mid, purl: 'https://unrelated.invalid/audio.mp3' }] });
      await assert.rejects(plugin.stream({ id: mid, quality: 'lossless' }), /invalid stream host/);
      assert.deepEqual(attempts, ['F000']);
    });
  });
}
