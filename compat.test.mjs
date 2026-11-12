import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import * as plugin from './index.js';

const storage = new Map();
const calls = [];
const prompts = [];
let respond;
globalThis.host = {
  setting: () => '', t: value => value,
  storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
  crypto: { md5: value => createHash('md5').update(value).digest('hex') },
  signInPrompt: value => prompts.push(value),
};
globalThis.fetch = async (address, options = {}) => {
  calls.push({ address: String(address), options });
  return respond(String(address), options);
};
const rpcResponse = data => Response.json({ code: 0, req_0: { code: 0, data } });
beforeEach(() => { plugin.signOut(); storage.clear(); calls.length = 0; prompts.length = 0; });

test('desktop search rejection falls back to QQ web search with the right page', async () => {
  respond = address => address.includes('musicu.fcg')
    ? Response.json({ code: 0, req_0: { code: 2001 } })
    : Response.json({ code: 0, data: { song: { totalnum: 100, list: [{ songmid: 'mid123', songname: '歌名', interval: 120, singer: [{ mid: 'artist1', name: '歌手' }], albummid: 'album1', albumname: '专辑' }] } } });
  const result = await plugin.search({ query: '中文 & song', kind: 'tracks', offset: 20 });
  const fallback = new URL(calls.at(-1).address);
  assert.equal(fallback.searchParams.get('w'), '中文 & song');
  assert.equal(fallback.searchParams.get('p'), '2');
  assert.equal(result.tracks[0].duration, 120000);
  assert.equal(result.tracks[0].id, 'mid123');
  assert.equal(result.more, true);
});

test('album search normalizes numeric release dates for the MyGo contract', async () => {
  respond = () => rpcResponse({ body: { album: { list: [
    { mid: 'album1', publicTime: 1327593600 },
    { mid: 'album2', aDate: '2024-03-01' },
  ] } }, meta: { sum: 2 } });
  const result = await plugin.search({ query: 'fixture dates', kind: 'albums' });
  assert.deepEqual(result.albums.map(a => a.released), ['2012-01-27', '2024-03-01']);
});

test('a malformed fallback does not pretend the search is empty', async () => {
  respond = address => address.includes('musicu.fcg')
    ? Response.json({ code: 0, req_0: { code: 2001 } })
    : Response.json({ code: 0, data: {} });
  await assert.rejects(plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 }), /malformed web search/);
});

test('signed-in playback accepts wifiurl without sip, as Lyrics does', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'W_fixture', loginType: 1 });
  respond = (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.comm.tmeLoginType, 1);
    return rpcResponse(request.req_0.method === 'get_song_detail_yqq'
      ? { track_info: { mid: 'songmid', file: { media_mid: 'mediamid' } } }
      : { midurlinfo: [{ songmid: 'songmid', purl: '', wifiurl: 'M500fixture.mp3?vkey=fixture' }] });
  };
  const result = await plugin.stream({ id: 'songmid', quality: 'standard' });
  assert.equal(new URL(result.url).host, 'isure.stream.qqmusic.qq.com');
  assert.equal(result.type, 'mp3');
  assert.equal(result.quality, 'standard');
});

test('a stream cannot redirect the player to an unrelated host', async () => {
  respond = (_url, options) => rpcResponse(JSON.parse(options.body).req_0.method === 'get_song_detail_yqq'
    ? { track_info: { mid: 'songmid' } }
    : { midurlinfo: [{ songmid: 'songmid', purl: 'https://example.net/audio.mp3' }] });
  await assert.rejects(plugin.stream({ id: 'songmid' }), /invalid stream host/);
});

async function loginFixture(onAccount = () => {}) {
  const png = await QRCode.toBuffer('https://open.weixin.qq.com/connect/confirm?uuid=fixture');
  respond = (address, options) => {
    if (address.includes('/ptqrshow')) return new Response('entropy', { headers: { 'set-cookie': `qrsig=${'a'.repeat(80)}; Path=/; Secure` } });
    if (address.includes('api.tencentmusic.com')) return Response.json({ data: { data: { q16: 'qimei16', q36: 'qimei36' } } });
    if (address.includes('/connect/qrcode/')) return new Response(png);
    if (address.includes('/connect/l/qrconnect')) return new Response("window.wx_errcode=405;window.wx_code='fixture-code';");
    if (address.includes('/connect/qrconnect')) return new Response('<img src="/connect/qrcode/fixture">');
    const body = JSON.parse(options.body);
    if (body.req_0?.method === 'GetSession') return rpcResponse({ session: { uid: 'device', sid: 'session' } });
    if (body.req?.method === 'Login') return Response.json({ code: 0, req: { code: 0, data: { str_musicid: '1152921504606846976', musickey: 'W_fixture', loginType: 1 } } });
    assert.equal(body.req_0.method, 'GetLoginUserInfo');
    assert.equal(body.comm.qq, '1152921504606846976');
    assert.equal(storage.has('qqmusic.auth.v1'), false, 'credentials are saved after profile validation');
    onAccount();
    return rpcResponse({ info: { nick: '微信用户', headurl: '' } });
  };
}

test('empty login setting completes WeChat flow and preserves a large music ID', async () => {
  await loginFixture();
  const result = await plugin.signIn();
  assert.equal(result.name, '微信用户');
  assert.equal(result.id, '1152921504606846976');
  assert.equal(storage.get('qqmusic.auth.v1').loginType, 1);
  assert.match(prompts[0].text, /WeChat/);
  assert.ok(prompts.some(p => p.qr?.startsWith('https://open.weixin.qq.com/')));
});

test('device limit rejection surfaces an actionable login error', async () => {
  const png = await QRCode.toBuffer('https://open.weixin.qq.com/connect/confirm?uuid=fixture');
  respond = (address, options) => {
    if (address.includes('/ptqrshow')) return new Response('entropy', { headers: { 'set-cookie': `qrsig=${'a'.repeat(80)}; Path=/; Secure` } });
    if (address.includes('api.tencentmusic.com')) return Response.json({ data: { data: { q16: 'qimei16', q36: 'qimei36' } } });
    if (address.includes('/connect/qrcode/')) return new Response(png);
    if (address.includes('/connect/l/qrconnect')) return new Response("window.wx_errcode=405;window.wx_code='fixture-code';");
    if (address.includes('/connect/qrconnect')) return new Response('<img src="/connect/qrcode/fixture">');
    const body = JSON.parse(options.body);
    if (body.req_0?.method === 'GetSession') return rpcResponse({ session: { uid: 'device', sid: 'session' } });
    if (body.req?.method === 'Login') return Response.json({ code: 0, req: { code: 20279, data: { musicid: 12345, str_musicid: '12345', loginType: 1, errtip: 'device limit reached' } } });
    throw new Error(`unexpected request ${address}`);
  };
  await assert.rejects(plugin.signIn(), error => error.qqGlobalCode === 0 && error.qqCode === 20279 && error.qqLoginStage === 'wechat-token-exchange' && error.qqTip === 'device limit reached' && /device limit reached/.test(error.message) && /0\/20279/.test(error.message));
  assert.equal(storage.has('qqmusic.auth.v1'), false);
});

test('signing out during final profile validation prevents a late login', async () => {
  await loginFixture(() => plugin.signOut());
  await assert.rejects(plugin.signIn(), /canceled/);
  assert.equal(storage.has('qqmusic.auth.v1'), false);
});
