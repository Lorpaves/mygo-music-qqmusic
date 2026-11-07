// Run with node --test test.mjs. QQ response fixtures are provisional.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mid = '0039MnYb0qxYhV';
const song = { mid, songmid: mid, id: 42, songid: 42, name: 'Fixture Song',
  title: 'Fixture Song', songname: 'Fixture Song', interval: 123,
  singer: [{ mid: 'artist-mid', name: 'Fixture Artist' }],
  album: { mid: 'album-mid', name: 'Fixture Album' } };
let calls = [];
let respond;
const storage = new Map();
const envelope = (data) => ({ code: 0, data, req: { code: 0, data },
  req_0: { code: 0, data }, req_1: { code: 0, data } });
const response = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { 'content-type': 'application/json' } });
const results = (list, total) => ({ body: { song: { list, total } },
  song: { list, total }, list, total, meta: { sum: total } });
const requested = () => decodeURIComponent(calls.map((x) =>
  `${x.url} ${JSON.stringify(x.init ?? {})}`).join('\n'));
const rpcParam = (call = calls.at(-1)) => JSON.parse(call.init.body).req_0.param;

globalThis.host = {
  platform: 'linux', arch: 'amd64', dir: '.', dataDir: '.',
  setting: () => '', t: (x) => x, language: () => 'en',
  storage: { get: (k) => storage.get(k), set: (k, v) => storage.set(k, v),
    remove: (k) => storage.delete(k) },
  crypto: { md5: () => 'mock-md5', aesEcbEncrypt: () => 'mock-aes' },
  signInPrompt: () => {}, openURL: () => {},
};
globalThis.fetch = async (input, init) => {
  calls.push({ url: input instanceof Request ? input.url : String(input), init });
  return respond(input, init);
};

let plugin;
try {
  plugin = await import(new URL('./index.js', import.meta.url));
} catch (cause) {
  throw new Error('Could not import index.js; the plugin must be a Node-importable ES module.', { cause });
}
beforeEach(() => {
  calls = [];
  storage.clear();
  respond = () => { throw new Error('Unexpected fetch'); };
});

test('search maps query and track metadata using MID as ID', async () => {
  respond = () => response(envelope(results([song], 1)));
  const result = await plugin.search({ query: 'Fixture Song', kind: 'tracks', offset: 0 });
  assert.ok(calls.length);
  assert.match(requested(), /Fixture(?:\+|\s)Song/i);
  assert.equal(rpcParam().query, 'Fixture Song');
  assert.equal(rpcParam().search_type, 0);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, mid);
  assert.equal(result.tracks[0].name, 'Fixture Song');
  assert.equal(result.tracks[0].artists[0].name, 'Fixture Artist');
  assert.equal(result.tracks[0].duration, 123000);
});

test('search propagates offset and reports pagination', async () => {
  respond = () => response(envelope(results([song], 100)));
  const first = await plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 });
  const firstRequest = requested();
  assert.equal(first.more, true);
  assert.equal(rpcParam().page_num, 1);
  assert.equal(rpcParam().num_per_page, 20);
  calls = [];
  await plugin.search({ query: 'fixture', kind: 'tracks', offset: 30 });
  assert.notEqual(requested(), firstRequest, 'offset must affect the request');
  assert.equal(rpcParam().page_num, 2);
  respond = () => response(envelope(results([], 0)));
  const last = await plugin.search({ query: 'fixture', kind: 'tracks', offset: 60 });
  assert.deepEqual(last.tracks ?? [], []);
  assert.equal(Boolean(last.more), false);
});

test('search continues after a result without a MID is filtered out', async () => {
  respond = () => response(envelope(results([song, { name: 'missing MID' }], 50)));
  const first = await plugin.search({ query: 'sparse', kind: 'tracks', offset: 0 });
  assert.equal(first.tracks.length, 1);
  await plugin.search({ query: 'sparse', kind: 'tracks', offset: first.tracks.length });
  assert.equal(rpcParam().page_num, 2);
});

test('suggestions are ordered, deduplicated and return names', async () => {
  respond = () => response({ code: 0, data: {
    song: { order: 1, itemlist: [{ name: 'Song' }, { name: 'Song' }] },
    singer: { order: 0, itemlist: [{ name: 'Artist' }] },
  } });
  assert.deepEqual(await plugin.suggest({ query: 'Artist' }), ['Artist', 'Song']);
});

test('artist pages include albums from the QQ album catalog', async () => {
  respond = (_input, init) => response(envelope(JSON.parse(init.body).req_0.method === 'get_singer_detail_info'
    ? { singer_info: { mid: 'artist-mid', name: 'Artist' }, songlist: [song] }
    : { albumList: [{ mid: 'album-mid', name: 'Album' }] }));
  const page = await plugin.artist({ id: 'artist-mid' });
  assert.equal(page.tracks[0].id, mid);
  assert.equal(page.albums[0].id, 'album-mid');
});

test('album pages include the account saved status', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (url, init) => String(url).includes('/v8/')
    ? response({ code: 0, data: { mid: 'album1', name: 'Album', list: [song] } })
    : response(envelope({ m_fan: { album1: true } }));
  const page = await plugin.album({ id: 'album1' });
  assert.equal(page.album.saved, true);
  assert.equal(JSON.parse(calls[1].init.body).req_0.method, 'IsAlbumFan');
});

test('personal radio needs an account and returns QQ radio tracks', async () => {
  await assert.rejects(() => plugin.stationNext({ id: 'personal-fm' }), { code: 'signIn' });
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = () => response(envelope({ tracks: [song] }));
  const tracks = await plugin.stationNext({ id: 'personal-fm' });
  assert.equal(tracks[0].id, mid);
  assert.equal(rpcParam().id, 99);
});

test('search surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 }));
});

test('search rejects unsupported kinds without a request', async () => {
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'shows', offset: 0 }),
    { code: 'unsupported' });
  assert.equal(calls.length, 0);
});

test('search surfaces QQ service errors', async () => {
  respond = () => response({ code: 0, req_0: { code: 123, data: {} } });
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 }));
});

test('stream requests the MID and returns a supported audio URL', async () => {
  respond = (_input, init) => {
    const { method } = JSON.parse(init.body).req_0;
    return response(envelope(method === 'get_song_detail_yqq'
      ? { track_info: { mid, file: { media_mid: 'media-mid' } } }
      : { sip: ['https://stream.qqmusic.qq.com/'],
        midurlinfo: [{ songmid: mid, purl: 'fixture.mp3' }] }));
  };
  const result = await plugin.stream({ id: mid, quality: 'standard' });
  assert.ok(calls.length);
  assert.ok(requested().includes(mid));
  assert.equal(rpcParam(calls[0]).song_mid, mid);
  assert.deepEqual(rpcParam(calls[1]).songmid, [mid]);
  assert.deepEqual(rpcParam(calls[1]).filename, [`M500${mid}media-mid.mp3`]);
  assert.equal(result.url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.match(result.url, /^https?:\/\//);
  assert.ok(['mp3', 'flac', 'ogg'].includes(result.type));
});

test('stream asks anonymous listeners to sign in when no URL is returned', async () => {
  respond = (_input, init) => response(envelope(
    JSON.parse(init.body).req_0.method === 'get_song_detail_yqq'
      ? { track_info: { mid } } : { sip: [], midurlinfo: [] }));
  await assert.rejects(() => plugin.stream({ id: mid, quality: 'standard' }),
    { code: 'signIn' });
});

test('signed-in lossless playback falls back to high quality without claiming lossless', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_input, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'get_song_detail_yqq') return response(envelope({ track_info: { mid, file: { media_mid: 'media-mid', size_320mp3: 500 } } }));
    assert.equal(req.method, 'UrlGetVkey');
    const purl = req.param.filename[0].startsWith('M800') ? 'high.mp3' : '';
    return response(envelope({ sip: ['https://stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: mid, purl }] }));
  };
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(result.quality, 'high');
  assert.equal(result.size, 500);
  assert.match(rpcParam(calls[1]).filename[0], /^F000/);
  assert.match(rpcParam(calls[2]).filename[0], /^M800/);
  assert.match(calls[2].init.headers.Cookie, /qm_keyst=Q_test/);
});

test('stream surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.stream({ id: mid, quality: 'standard' }));
});

test('lyrics requests the MID and returns LRC', async () => {
  const lrc = '[00:01.00]Fixture lyric';
  respond = () => response({ code: 0, lyric: Buffer.from(lrc).toString('base64'),
    trans: Buffer.from('[00:01.00]Translation').toString('base64') });
  const result = await plugin.lyrics({ id: mid });
  assert.ok(calls.length);
  assert.ok(requested().includes(mid));
  assert.match(result.lrc, /Fixture lyric/);
  assert.match(result.translation, /Translation/);
});

test('lyrics use the translation endpoint when legacy lyrics have no translation', async () => {
  respond = (url) => String(url).includes('/lyric/')
    ? response({ code: 0, lyric: Buffer.from('[00:01.00]Original').toString('base64') })
    : response(envelope({ trans: Buffer.from('[00:01.00]Translated').toString('base64') }));
  assert.equal((await plugin.lyrics({ id: mid })).translation, '[00:01.00]Translated');
});

test('home adds the signed-in recommendation feed', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_url, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'GetRecommendFeed') return response(envelope({ List: [] }));
    if (req.method === 'GetAll') return response(envelope({ group: [] }));
    if (req.method === 'get_recommend_feed') return response(envelope({ retcode: 0, v_shelf: [{ v_niche: [{ v_card: [{ id: '100', type: 500, subtype: 0, jumptype: 10014, title: 'For you' }] }] }] }));
    throw new Error(`Unexpected request: ${req.method}`);
  };
  const result = await plugin.home();
  assert.equal(result.sections[0].playlists[0].id, '100');
});

test('lyrics surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.lyrics({ id: mid }));
});

test('integrated sign-in passes the authenticated session to the library', async () => {
  respond = (_url, init) => {
    const method = JSON.parse(init.body).req_0.method;
    if (method === 'GetLoginUserInfo') return response(envelope({ info: { nick: 'Listener' } }));
    if (method === 'IsSongFanByMid') return response(envelope({ m_fan: { [mid]: true } }));
    throw new Error(`Unexpected request: ${method}`);
  };
  assert.equal((await plugin.qqFinishSignIn({ musicid: '12345', musickey: 'Q_test', loginType: 2 })).name, 'Listener');
  assert.deepEqual(await plugin.isLiked({ ids: [mid] }), { [mid]: true });
  assert.equal(JSON.parse(calls.at(-1).init.body).comm.authst, 'Q_test');
  plugin.signOut();
  assert.deepEqual(await plugin.isLiked({ ids: [mid] }), { [mid]: false });
});

test('comments use the anonymous endpoint even after signing in', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_url, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'get_song_detail_yqq') return response(envelope({ track_info: { mid, id: 42 } }));
    assert.equal(init.headers.Cookie, undefined);
    return response(envelope({ CommentList: { Total: 0, HasMore: 0, Comments: [] } }));
  };
  assert.deepEqual((await plugin.comments({ trackId: mid })).comments, []);
});
