import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowse } from './index.js';

const trackOf = raw => ({ id: raw.mid || raw.songmid || '', name: raw.title || '' });
const setup = (reply, cgi = async () => { throw Error('unexpected CGI'); }) => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return reply(...args); };
  return { api: createBrowse({ rpc, cgi, trackOf }), calls };
};

test('home displays public playlists and song charts only', async () => {
  const { api, calls } = setup(async (_module, method) => method === 'GetRecommendFeed'
    ? { List: [{ Playlist: { basic: { tid: 123, title: 'Playlist', cover: { default_url: 'cover' }, creator: { nick: 'owner' } } } }] }
    : { group: [{ toplist: [{ topId: 62, recType: 10005, title: 'Chart' }, { topId: 23, recType: 10010 }] }] });
  const home = await api.home();
  assert.equal(home.sections[0].playlists[0].id, '123');
  assert.equal(home.sections[0].playlists[0].owner, 'owner');
  assert.deepEqual(home.sections[1].playlists.map(x => x.id), ['chart:62']);
  assert.deepEqual(calls[1][3], { ct: 24, cv: 0 });
  await assert.rejects(() => api.browse({ page: 'unknown' }), { code: 'unavailable' });
});

test('playlist loads public CGI and chart RPC, rejecting invalid shells', async () => {
  let request;
  const { api, calls } = setup(async () => ({ data: { recType: 10005, title: 'Chart' }, songInfoList: [{ mid: 'mid1' }] }),
    async (...args) => { request = args; return { cdlist: [{ dissname: 'List', songnum: 1, songlist: [{ songmid: 'mid2' }] }] }; });
  assert.equal((await api.playlist({ id: 'chart:62' })).tracks[0].id, 'mid1');
  assert.equal(calls[0][2].topid, 62);
  assert.equal((await api.playlist({ id: '123' })).tracks[0].id, 'mid2');
  assert.equal(request[1].disstid, '123');
  await assert.rejects(() => api.playlist({ id: 'chart:wrong' }), { code: 'unavailable' });
  const bad = setup(async () => ({ data: { recType: 10010 }, songInfoList: [] })).api;
  await assert.rejects(() => bad.playlist({ id: 'chart:23' }), { code: 'unavailable' });
});

test('playlist search uses desktop songlist response and reports filtering', async () => {
  let filtered = false;
  const { api, calls } = setup(async () => ({ body: { songlist: { list: filtered ? [] : [{ dissid: 12, dissname: 'List', imgurl: 'cover', song_count: 3, creator: { name: 'Owner' } }] } }, meta: { sum: 100, is_filter: filtered ? -9 : 0 } }));
  const result = await api.searchPlaylists({ query: ' hello ', offset: 20 });
  assert.equal(result.playlists[0].id, '12');
  assert.equal(result.playlists[0].owner, 'Owner');
  assert.equal(result.more, true);
  assert.deepEqual(calls[0][2], { query: 'hello', search_type: 3, num_per_page: 20, page_num: 2 });
  filtered = true;
  await assert.rejects(() => api.searchPlaylists({ query: 'hello' }), /filtered/);
  assert.deepEqual(await api.searchPlaylists({ query: ' ' }), { playlists: [], more: false });
});

test('comments resolve MID and carry cursor and opaque version', async () => {
  const { api, calls } = setup(async (_module, method, param) => {
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'mid', id: 42 } };
    return param.PageNum === 0
      ? { TotalVer: '1793343305312403406', CommentList: { Total: 2, HasMore: 1, Comments: [{ CmId: 'x!', SeqNo: '18446744073709551615', Content: 'A &amp; B', PubTime: 2 }] } }
      : { CommentList: { Total: 2, HasMore: false, Comments: [{ CmId: 'y!', Content: 'Second' }] } };
  });
  const first = await api.comments({ trackId: 'mid' });
  assert.equal(first.comments[0].text, 'A & B');
  assert.equal(first.comments[0].time, 2000);
  assert.equal(first.more, true);
  assert.equal((await api.comments({ trackId: 'mid', offset: 1 })).more, false);
  assert.equal(calls[2][2].LastCommentSeqNo, '18446744073709551615');
  assert.equal(calls[2][2].LastTotalVer, '1793343305312403406');
  await assert.rejects(() => api.comments({ trackId: 'other', offset: 1 }), { code: 'unavailable' });
});

test('malformed comments and missing song identity are errors', async () => {
  const missing = setup(async () => ({ track_info: { mid: 'mid' } })).api;
  await assert.rejects(() => missing.comments({ trackId: 'mid' }), { code: 'unavailable' });
  const malformed = setup(async (_module, method) => method === 'get_song_detail_yqq' ? { track_info: { mid: 'mid', id: 42 } } : {}).api;
  await assert.rejects(() => malformed.comments({ trackId: 'mid' }), /missing comments/);
});

test('search advances after entries without IDs are discarded', async () => {
  const { api, calls } = setup(async () => ({ body: { songlist: { list: [{ dissid: 9 }, {}] } }, meta: { sum: 100 } }));
  await api.searchPlaylists({ query: 'test' });
  await api.searchPlaylists({ query: 'test', offset: 1 });
  assert.equal(calls[1][2].page_num, 2);
});

test('comments skip duplicate-only pages and keep offsets usable', async () => {
  const { api, calls } = setup(async (_module, method, param) => {
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'mid', id: 42 } };
    const page = param.PageNum;
    return { CommentList: { Total: 3, HasMore: page < 3, Comments: [{ CmId: page < 2 ? 'a' : page === 2 ? 'b' : 'c', SeqNo: String(page + 1) }] } };
  });
  assert.equal((await api.comments({ trackId: 'mid' })).comments[0].id, 'a');
  assert.equal((await api.comments({ trackId: 'mid', offset: 1 })).comments[0].id, 'b');
  assert.equal((await api.comments({ trackId: 'mid', offset: 2 })).comments[0].id, 'c');
  assert.equal(calls.length, 5);
});

test('anonymous live QQ endpoints', { skip: !process.env.QQ_LIVE, timeout: 120000 }, async t => {
  const headers = { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' };
  async function rpc(module, method, param, comm = { ct: 24, cv: 0 }) {
    const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', headers, body: JSON.stringify({ comm, req_0: { module, method, param } }) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 0 || !body.req_0 || body.req_0.code !== 0 || body.req_0.subcode) throw Error(`QQ ${method}: ${body.code}/${body.req_0?.code}`);
    if (!body.req_0.data) throw Error(`QQ ${method}: missing data`);
    return body.req_0.data;
  }
  async function cgi(path, params) {
    const query = new URLSearchParams({ ...params, format: 'json', outCharset: 'utf-8' });
    const response = await fetch(`https://c.y.qq.com${path}?${query}`, { headers });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 0 || body.subcode) throw Error(`QQ CGI: ${body.code}`);
    return body;
  }
  const api = createBrowse({ rpc, cgi, trackOf });
  let featured, ranking, song;
  await t.test('featured', async () => { featured = await api.featuredPlaylists(); assert.ok(featured.length); console.log('featured count', featured.length); });
  await t.test('public playlist detail', async () => { assert.ok(featured?.length); const p = await api.playlist({ id: featured[0].id }); assert.ok(p.tracks.length); song = p.tracks[0].id; console.log('playlist', p.id, 'tracks', p.tracks.length, 'total', p.trackCount); });
  await t.test('charts', async () => { ranking = await api.charts(); assert.ok(ranking.length); console.log('charts count', ranking.length); });
  await t.test('chart detail', async () => { assert.ok(ranking?.length); const p = await api.playlist({ id: ranking[0].id }); assert.ok(p.tracks.length); song ||= p.tracks[0].id; console.log('chart', p.id, 'tracks', p.tracks.length, 'total', p.trackCount); });
  await t.test('playlist search', async () => { const p = await api.searchPlaylists({ query: '周杰伦' }); assert.ok(p.playlists.length); console.log('search count', p.playlists.length, 'more', p.more); });
  await t.test('comments', async () => { assert.ok(song); const p = await api.comments({ trackId: song }); console.log('comments count', p.comments.length, 'more', p.more, 'total', p.total); if (p.more) { const next = await api.comments({ trackId: song, offset: p.comments.length }); console.log('next comments count', next.comments.length, 'more', next.more); } });
});
