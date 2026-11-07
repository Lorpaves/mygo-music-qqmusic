// Read-only live checks. --signed-in reads this plugin's saved session locally;
// credentials, API bodies and signed playback URLs are never logged or written.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const signedIn = process.argv.includes('--signed-in');
const locale = JSON.parse(await readFile(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'));
const stored = signedIn ? JSON.parse(await readFile(new URL('../../plugin-data/qqmusic/storage.json', import.meta.url), 'utf8')) : {};
const storage = new Map(Object.entries(stored));
const network = globalThis.fetch;
globalThis.fetch = (url, options = {}) => network(url, { ...options, signal: AbortSignal.timeout(30000) });
globalThis.host = {
  t: value => locale[value] || value, language: () => 'zh-CN', setting: () => '',
  platform: process.platform, arch: process.arch, dir: fileURLToPath(new URL('.', import.meta.url)),
  storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
  crypto: { md5: value => createHash('md5').update(value).digest('hex') },
};
const plugin = await import('./dist/index.js');
let failed = 0;
async function check(name, action) {
  const start = Date.now();
  try { const result = await action(); console.log('PASS', name, JSON.stringify(result), `${Date.now()-start}ms`); return result; }
  catch (error) { failed++; console.log('FAIL', name, error.code || '', error.message.replace(/https?:\/\/\S+/g, '[URL]')); return null; }
}
let first;
await check('account', async () => { const account = await plugin.account(); if (signedIn && !account) throw new Error('No valid saved session'); return { signedIn: !!account }; });
for (const kind of ['tracks', 'artists', 'albums', 'playlists']) await check(`search ${kind}`, async () => {
  const result = await plugin.search({ query: '周杰伦', kind, offset: 0 });
  if (!result[kind]?.length) throw new Error('No results');
  if (kind === 'tracks') first = result.tracks[0];
  return { count: result[kind].length, more: result.more };
});
await check('search next page', async () => ({ count: (await plugin.search({ query: '周杰伦', kind: 'tracks', offset: 20 })).tracks.length }));
await check('suggestions', async () => ({ count: (await plugin.suggest({query:'周杰'})).length }));
let featured;
await check('home', async () => { const page = await plugin.home(); featured = page.sections.flatMap(s => s.playlists || []).find(p => /^\d+$/.test(p.id)); return { sections: page.sections.length }; });
await check('chart', async () => ({ count: (await plugin.playlist({ id: 'chart:26' })).tracks.length }));
if (featured) await check('playlist', async () => { const list = await plugin.playlist({id:featured.id}); return { tracks: list.tracks.length, total: list.trackCount }; });
if (first) {
  await check('album', async () => ({ count: (await plugin.album({id:first.album.id})).tracks.length }));
  await check('artist', async () => { const page=await plugin.artist({id:first.artists[0].id}); return { tracks:page.tracks.length, albums:page.albums.length }; });
  await check('lyrics', async () => { const result=await plugin.lyrics({id:first.id}); return { lines:result.lines?.length || result.lrc?.split('\n').length || 0 }; });
  await check('comments', async () => { const result=await plugin.comments({trackId:first.id,offset:0});return { comments:result.comments.length, more:result.more }; });
}
if (signedIn) {
  await check('my playlists', async () => ({ count:(await plugin.playlists()).length }));
  await check('liked songs', async () => {const result=await plugin.liked({offset:0});return { count:result.tracks.length, more:result.more };});
  await check('saved albums', async () => {
    const result = await plugin.savedAlbums({offset:0});
    if (result.albums.some(a => typeof a.released !== 'string')) throw new Error('Album release date violates MyGo string contract');
    return { count: result.albums.length, releaseDatesValid: true };
  });
}
// A public, playable song from the current chart; do not use a paid song to test anonymous playback.
for (const quality of signedIn ? ['standard','high','lossless'] : ['standard']) await check(`audio ${quality}`, async () => {
  const result=await plugin.stream({id:'00255MYE3GNkZF',quality});
  const response=await fetch(result.url,{headers:{...result.headers,Range:'bytes=0-8191'}});
  if(!response.ok)throw new Error(`Audio HTTP ${response.status}`);
  const reader=response.body.getReader();const sample=await reader.read();await reader.cancel();
  const bytes=sample.value || new Uint8Array();
  const head=Buffer.from(bytes).subarray(0,4).toString('hex');
  const valid=bytes.length>512&&(head.startsWith('494433')||head==='664c6143'||head==='4f676753'||bytes[0]===255&&(bytes[1]&224)===224);
  if(!valid)throw new Error('Invalid audio header');
  return {type:result.type,quality:result.quality,bytes:bytes.length};
});
console.log(failed ? `${failed} live checks failed` : 'All live checks passed');
process.exitCode=failed?1:0;
