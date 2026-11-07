import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary } from './index.js';

const signed = { musicid: '10001', musickey: 'test', loginType: 2, encryptUin: 'encrypted' };
function setup(handler, session = signed, options = {}) {
  const calls = [];
  const lib = createLibrary({
    qqReadSession: () => session,
    qqAuthRpc: async (module, method, param, s) => { calls.push({ module, method, param }); assert.equal(s, session); return handler(method, param); },
    cgi: async () => ({ cdlist: [{ dissname: 'Public', songlist: [{ mid: 'song1' }] }] }),
    qqAuthCgi: options.qqAuthCgi,
    fetch: options.fetch,
    trackOf: t => ({ id: t.mid, name: t.name || '' }),
  });
  return { lib, calls };
}
const own = { tid: 900, dirId: 12, dirType: 0, dirName: 'Mine', uin: '10001' };
const ok = { retCode: 0, result: { tid: 900, dirId: 12 } };

test('missing encryptUin is an error, not an empty library', async () => {
  const { lib, calls } = setup(() => { throw new Error('unexpected'); }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async () => new Response(JSON.stringify({ code: 0, data: { creator: {} } })) });
  await assert.rejects(lib.playlists(), /encryptUin/);
  await assert.rejects(lib.liked({}), /encryptUin/);
  assert.equal(calls.length, 0);
});

test('playlists combines owned and paginated favorites', async () => {
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetPlaylistFavInfo');
    assert.equal(p.uin, 'encrypted');
    return p.offset === 0 ? { v_list: [{ tid: 901, name: 'Saved' }], hasmore: 1 } : { v_list: [{ tid: 902, name: 'Next' }], hasmore: 0 };
  });
  assert.deepEqual((await lib.playlists()).map(p => [p.id, p.name, p.mine]), [['900', 'Mine', true], ['901', 'Saved', false], ['902', 'Next', false]]);
});

test('liked forwards offset and validates song list', async () => {
  const { lib } = setup((method, p) => {
    assert.equal(method, 'CgiGetDiss');
    assert.equal(p.song_begin, 20); assert.equal(p.enc_host_uin, 'encrypted');
    return { songlist: [{ mid: 'song1' }], hasmore: 1 };
  });
  assert.deepEqual(await lib.liked({ offset: 20 }), { tracks: [{ id: 'song1', name: '' }], more: true });
});

test('like resolves MID to numeric song ID and confirms state', async () => {
  let liked = false, writes = 0;
  const { lib } = setup((method, p) => {
    if (method === 'IsSongFanByMid') return { m_fan: { song1: liked } };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'song1', id: 42 } };
    if (method === 'AddSonglist') { writes++; assert.deepEqual(p, { dirId: 201, v_songInfo: [{ songId: 42, songType: 0 }] }); liked = true; return ok; }
    throw new Error(method);
  }, { musicid: '10001', musickey: 'test', loginType: 2 });
  await lib.like({ id: 'song1', on: true });
  await lib.like({ id: 'song1', on: true });
  assert.equal(writes, 1);
  assert.deepEqual(await lib.isLiked({ ids: ['song1'] }), { song1: true });
});

test('playlist edit resolves owned directory and rejects system lists', async () => {
  const { lib, calls } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own, { tid: 901, dirId: 201, dirType: 0 }] };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: p.song_mid, id: 42 } };
    if (method === 'AddSonglist') { assert.deepEqual(p, { dirId: 12, v_songInfo: [{ songId: 42, songType: 0 }] }); return ok; }
    throw new Error(method);
  });
  await lib.addToPlaylist({ id: '900', trackIds: ['song1'] });
  await assert.rejects(lib.addToPlaylist({ id: '901', trackIds: ['song1'] }), /ordinary/);
  assert.equal(calls.filter(c => c.method === 'AddSonglist').length, 1);
});

test('playlist pages and public response map tracks', async () => {
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetDiss');
    return { dirinfo: { title: 'Mine' }, total_song_num: 2, songlist: [{ mid: p.song_begin ? 'song2' : 'song1' }], hasmore: p.song_begin ? 0 : 1 };
  });
  assert.deepEqual((await lib.playlist({ id: '900' })).tracks.map(t => t.id), ['song1', 'song2']);
  assert.equal((await lib.playlist({ id: '901' })).name, 'Public');
});

test('rename preserves settings and verifies them', async () => {
  let title = 'Mine';
  const info = () => ({ dirid: 12, title, desc: 'desc', picurl: 'cover', picurl2: '', tag: [{ id: 3 }], dir_show: 2 });
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    if (method === 'uniform_get_Dissinfo') return { dirinfo: info() };
    if (method === 'EditPlaylist') { assert.equal(p.dirNewDesc, 'desc'); assert.equal(p.dirNewtaglist, '3'); title = p.dirNewName; return ok; }
    throw new Error(method);
  });
  await lib.renamePlaylist({ id: '900', name: 'Renamed' });
});

test('failed or incomplete writes are errors', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'song1', id: 42 } };
    if (method === 'DelSonglist') return { retCode: 1, result: {} };
    throw new Error(method);
  });
  await assert.rejects(lib.removeFromPlaylist({ id: '900', trackIds: ['song1'] }), /confirm/);
});

test('create and delete verify the account playlist listing', async () => {
  let entries = [];
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: entries };
    if (method === 'AddPlaylist') { entries = [own]; return ok; }
    if (method === 'DelPlaylist') { entries = []; return { retCode: 0, result: { tid: 900, dirId: 12, updateTime: 0 } }; }
    throw new Error(method);
  });
  assert.equal((await lib.createPlaylist({ name: 'Mine' })).id, '900');
  await lib.deletePlaylist({ id: '900' });
});

test('system playlist is not editable and inner errors are rejected', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [{ ...own, dirId: 201 }] };
    if (method === 'CgiGetPlaylistFavInfo') return { v_list: [], hasmore: 0 };
    return { subcode: 5, songlist: [] };
  });
  const system = (await lib.playlists())[0];
  assert.equal(system.mine, true);
  assert.equal(system.fixed, true);
  await assert.rejects(lib.liked({}), /rejected/);
});

test('current owned lists without dirType remain mine and system lists remain fixed', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [
      { tid: 900, dirId: 12, dirName: 'Mine', uin: '10001' },
      { tid: 901, dirId: 201, dirName: 'Liked', uin: '10001' },
      { tid: 902, dirId: 14, dirName: 'Different owner', uin: '99999' },
    ] };
    if (method === 'CgiGetPlaylistFavInfo') return { v_list: [], hasmore: 0 };
    throw new Error('Unexpected write');
  });
  assert.deepEqual((await lib.playlists()).map(p => [p.mine, p.fixed]), [[true, false], [true, true], [false, true]]);
  await assert.rejects(lib.deletePlaylist({id:'901'}), /ordinary/);
  await assert.rejects(lib.deletePlaylist({id:'902'}), /ordinary/);
});

test('signed out returns empty playlists and false statuses without network', async () => {
  const { lib, calls } = setup(() => { throw new Error('unexpected'); }, null);
  assert.deepEqual(await lib.playlists(), []);
  assert.deepEqual(await lib.isLiked({ ids: ['song1', 'song2'] }), { song1: false, song2: false });
  for (const f of [() => lib.liked(), () => lib.like({ id: 'song1', on: true }), () => lib.savedAlbums(), () => lib.saveAlbum({ id: 'album1', on: true }), () => lib.createPlaylist({ name: 'x' })]) await assert.rejects(f, { code: 'signIn' });
  assert.equal(calls.length, 0);
});

test('profile CGI resolves encrypt_uin from musicid for library calls', async () => {
  const urls = [];
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [] };
    if (method === 'CgiGetPlaylistFavInfo') { assert.equal(p.uin, 'resolved'); return { v_list: [], hasmore: 0 }; }
    assert.equal(p.enc_host_uin, 'resolved');
    return { songlist: [], hasmore: 0 };
  }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ code: 0, data: { creator: { encrypt_uin: 'resolved' } } }));
  } });
  await lib.playlists(); await lib.liked();
  assert.equal(urls.length, 2);
  assert.equal(urls[0].hostname, 'c6.y.qq.com');
  assert.equal(urls[0].pathname, '/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), { ct: '20', cv: '4747474', cid: '205360838', userid: '10001', format: 'json' });
});

test('profile CGI HTTP and service errors do not access the library', async () => {
  for (const reply of [new Response('', { status: 503 }), new Response(JSON.stringify({ code: 100, data: { creator: { encrypt_uin: 'wrong' } } }))]) {
    const { lib, calls } = setup(() => { throw new Error('unexpected'); }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async () => reply });
    await assert.rejects(lib.playlists());
    assert.equal(calls.length, 0);
  }
});

test('saved albums use authenticated CGI, inclusive ranges and MID metadata', async () => {
  const { lib } = setup(() => { throw new Error('unexpected'); }, signed, { qqAuthCgi: async (path, p, s) => {
    assert.equal(s, signed); assert.equal(path, '/fav/fcgi-bin/fcg_get_profile_order_asset.fcg');
    assert.deepEqual(p, { ct: 20, cid: 205360956, userid: '10001', reqtype: 2, sin: 20, ein: 39 });
    return { code: 0, data: { totalalbum: 22, albumlist: [{ albummid: 'AlbumMID', albumname: 'Album', singername: 'Singer' }] } };
  } });
  const page = await lib.savedAlbums({ offset: 20 });
  assert.equal(page.more, true); assert.equal(page.albums[0].id, 'AlbumMID'); assert.equal(page.albums[0].artists[0].name, 'Singer');
});

test('saved album dates satisfy MyGo string fields and preserve the China release day', async () => {
  const values = [1327593600, 1327593600000, '2012-01-27', 2024, 0, null, undefined, 946656000, 946656000000, -315648000];
  const { lib } = setup(() => { throw new Error('unexpected'); }, signed, { qqAuthCgi: async () => ({
    code: 0, data: { totalalbum: values.length, albumlist: values.map((release_time, i) => ({ albummid: `Album${i}`, release_time })) },
  }) });
  const page = JSON.parse(JSON.stringify(await lib.savedAlbums()));
  assert.deepEqual(page.albums.map(a => a.released), ['2012-01-27', '2012-01-27', '2012-01-27', '2024', '', '', '', '2000-01-01', '2000-01-01', '1960-01-01']);
  assert.ok(page.albums.every(a => typeof a.released === 'string'));
});

test('album save and unsave use MID, avoid duplicates and verify writes', async () => {
  let saved = false, writes = 0;
  const { lib } = setup((method, p) => {
    assert.deepEqual(p.v_albumMid, ['AlbumMID']);
    if (method === 'IsAlbumFan') { assert.equal(p.uin, 10001); return { m_fan: { AlbumMID: saved } }; }
    assert.equal(p.uin, '10001'); writes++; saved = method === 'FavAlbum';
    return { result: 0, v_failedAlbumId: [], v_failedAlbumMid: [] };
  });
  await lib.saveAlbum({ id: 'AlbumMID', on: true });
  await lib.saveAlbum({ id: 'AlbumMID', on: true });
  await lib.saveAlbum({ id: 'AlbumMID', on: false });
  assert.equal(writes, 2);
});

test('album errors do not masquerade as success', async () => {
  const { lib } = setup(method => method === 'IsAlbumFan' ? { m_fan: { AlbumMID: false } } : { result: 0 }, signed, { qqAuthCgi: async () => ({ code: 0, data: { totalalbum: 1, albumlist: [] } }) });
  await assert.rejects(lib.savedAlbums(), /incomplete/);
  await assert.rejects(lib.saveAlbum({ id: 'AlbumMID', on: true }), /confirm/);
});
