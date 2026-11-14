import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

for (const entry of ['./index.js', './dist/index.js']) {
  const plugin = await import(entry);
  describe(`public playlist fallback: ${entry}`, () => {
    const id = '9265590159', key = 'qqmusic.auth.v1';
    const session = { musicid: '12345', musickey: 'W_fixture', loginType: 1 };
    const storage = new Map();
    let calls, legacy, page;
    const rpc = data => Response.json({ code: 0, req_0: { code: 0, data } });
    const info = { id, title: 'Playlist', picurl: 'cover', desc: 'description', host_nick: 'Owner' };
    const success = () => Response.json({ code: 0, subcode: 0, cdlist: [{ dissname: 'Legacy', songnum: 1, songlist: [{ mid: 'one' }] }] });
    beforeEach(() => {
      globalThis.host = { t: x => x, storage: { get: k => storage.get(k), set: (k, v) => storage.set(k, v), remove: k => storage.delete(k) } };
      plugin.signOut(); storage.clear(); calls = [];
      legacy = () => Response.json({ code: 0, subcode: -1 });
      page = () => rpc({ code: 0, dirinfo: info, songlist: [{ mid: 'one' }], total_song_num: 1, hasmore: 0 });
      globalThis.fetch = async (url, options) => {
        const method = options.body ? JSON.parse(options.body).req_0.method : 'CGI';
        calls.push(method);
        if (method === 'CGI') return legacy();
        const request = JSON.parse(options.body);
        if (method === 'GetPlaylistByUin') return rpc({ v_playlist: [] });
        assert.equal(request.req_0.module, 'music.srfDissInfo.aiDissInfo');
        assert.equal(method, 'uniform_get_Dissinfo');
        assert.equal(request.req_0.param.disstid, Number(id));
        assert.equal(request.req_0.param.song_num, 100);
        return page(request, options);
      };
    });

    for (const signed of [false, true]) test(`legacy code 0/subcode -1 uses paginated RPC (${signed ? 'signed in' : 'anonymous'})`, async () => {
      if (signed) storage.set(key, session);
      const offsets = [];
      page = (request, options) => {
        const offset = request.req_0.param.song_begin; offsets.push(offset);
        if (signed) { assert.match(options.headers.Cookie, /W_fixture/); assert.equal(request.comm.tmeLoginType, 1); }
        else assert.equal(options.headers.Cookie, undefined);
        return rpc({ code: 0, subcode: 0, dirinfo: info, songlist: [{ mid: `song${offset}`, name: `Song ${offset}` }], total_song_num: 3, hasmore: offset < 2 ? 1 : 0 });
      };
      const result = await plugin.playlist({ id });
      assert.deepEqual(offsets, [0, 1, 2]);
      assert.equal(result.id, id); assert.equal(result.name, 'Playlist'); assert.equal(result.imageUrl, 'cover');
      assert.equal(result.owner, 'Owner'); assert.equal(result.trackCount, 3);
      assert.deepEqual(result.tracks.map(t => t.id), ['song0', 'song1', 'song2']);
      assert.equal(calls.filter(m => m === 'CGI').length, 1);
      if (signed) { assert.deepEqual(storage.get(key), session); assert.equal(result.mine, false); }
    });

    test('successful CGI does not make a second request', async () => {
      legacy = success;
      assert.equal((await plugin.playlist({ id })).name, 'Legacy');
      assert.deepEqual(calls, ['CGI']);
    });

    test('string zero codes are successful', async () => {
      legacy = () => Response.json({ code: '0', subcode: '0', cdlist: [{ songlist: [] }] });
      assert.deepEqual((await plugin.playlist({ id })).tracks, []);
      assert.deepEqual(calls, ['CGI']);
    });

    test('CGI error reports the actual subcode without leaking response data', async () => {
      legacy = () => Response.json({ code: 0, subcode: -42, message: 'private fixture' });
      // Exercise CGI through a non-playlist fallback, where the error propagates.
      globalThis.fetch = async (url, options) => options.body
        ? Response.json({ code: 0, req_0: { code: 2001 } }) : legacy();
      await assert.rejects(plugin.search({ query: 'fixture', kind: 'playlists' }), e =>
        e.message === 'QQ Music CGI: 0/-42' && e.qqGlobalCode === 0 && e.qqCode === -42);
    });

    for (const status of [401, 403, 429, 503]) test(`HTTP ${status} is not hidden by fallback`, async () => {
      legacy = () => new Response('', { status });
      await assert.rejects(plugin.playlist({ id }), new RegExp(`HTTP ${status}`));
      assert.deepEqual(calls, ['CGI']);
    });

    for (const name of ['AbortError', 'TypeError', 'SyntaxError']) test(`${name} is not retried`, async () => {
      const failure = new Error('fixture'); failure.name = name;
      legacy = () => { throw failure; };
      await assert.rejects(plugin.playlist({ id }), e => e === failure);
      assert.deepEqual(calls, ['CGI']);
    });

    test('RPC business rejection remains an error', async () => {
      page = () => rpc({ code: 0, subcode: -7 });
      await assert.rejects(plugin.playlist({ id }), /0\/-7/);
    });

    test('RPC authentication rejection does not clear the stored session', async () => {
      storage.set(key, session);
      page = () => Response.json({ code: 0, req_0: { code: 104401 } });
      await assert.rejects(plugin.playlist({ id }), /104401/);
      assert.deepEqual(storage.get(key), session);
    });

    for (const [name, songs, total, more, expected] of [
      ['empty page with more', [], 2, 1, /incomplete/],
      ['empty page below total', [], 2, 0, /incomplete/],
      ['missing songs', undefined, 1, 0, /missing playlist songs/],
      ['song without MID', [{}], 1, 0, /missing playlist song MID/],
      ['invalid total', [{ mid: 'one' }], -1, 0, /invalid playlist total/],
      ['repeated page', [{ mid: 'one' }], 2, 1, /paging repeated/],
    ]) test(`${name} does not return a partial playlist`, async () => {
      page = () => rpc({ dirinfo: info, songlist: songs, total_song_num: total, hasmore: more });
      await assert.rejects(plugin.playlist({ id }), expected);
      assert.ok(calls.length <= 3);
    });

    test('a valid empty playlist is still supported', async () => {
      page = () => rpc({ dirinfo: info, songlist: [], total_song_num: 0, hasmore: 0 });
      assert.equal((await plugin.playlist({ id })).tracks.length, 0);
    });

    test('a mismatched playlist ID is rejected', async () => {
      page = () => rpc({ dirinfo: { ...info, id: '123' }, songlist: [], total_song_num: 0 });
      await assert.rejects(plugin.playlist({ id }), /playlist unavailable/);
    });

    test('unsafe numeric IDs are rejected before network access', async () => {
      await assert.rejects(plugin.playlist({ id: '99999999999999999999' }), /Invalid playlist ID/);
      assert.deepEqual(calls, []);
    });
  });
}
