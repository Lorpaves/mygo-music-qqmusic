import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './index.js';

const authKey = 'qqmusic.auth.v1', profileKey = 'qqmusic.profile.v1';
const storage = new Map();
let respond;
globalThis.host = {
  t: value => value,
  storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
};
globalThis.fetch = async (_address, options) => respond(JSON.parse(options.body));
const now = () => Math.floor(Date.now() / 1000);
const session = (id = '11111', overrides = {}) => ({ musicid: id, musickey: `fixture-${id}`, loginType: 2,
  refresh_token: `refresh-${id}`, musickeyCreateTime: now() - 259140, keyExpiresIn: 259200, ...overrides });
const profile = id => ({ id, name: 'Fixture', imageUrl: '' });
const profileReply = () => Response.json({ code: 0, req_0: { code: 0, data: { info: { nick: 'Fixture' } } } });
const rejectedProfile = code => Response.json({ code: 0, req_0: { code, data: null } });
const refreshed = s => Response.json({ code: 0, req: { code: 0, data: { ...s, musickey: 'renewed-'+s.musicid, musickeyCreateTime: now(), refresh_token: 'rotated-'+s.musicid } } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { plugin.signOut(); storage.clear(); respond = () => { throw new Error('Unexpected request'); }; });

// A late QQ renewal must not restore a session after sign-out or overwrite another account.
for (const replacement of [null, '22222']) test(`late QQ refresh cannot replace ${replacement || 'signed-out state'}`, async () => {
  const original = session(), entered = deferred(), reply = deferred(); storage.set(authKey, original);
  respond = body => { if (body.req) { entered.resolve(); return reply.promise; } return profileReply(); };
  const pending = assert.rejects(plugin.account(), /account changed/);
  await entered.promise;
  plugin.signOut();
  if (replacement) await plugin.qqFinishSignIn(session(replacement, { loginType: 1 }));
  reply.resolve(refreshed(original)); await pending;
  assert.equal(storage.get(authKey)?.musicid, replacement || undefined);
  assert.equal(storage.get(profileKey)?.id, replacement || undefined);
});

// Account changes invalidate successful and rejected profile replies before either mutates state.
for (const rejected of [false, true]) test(`late ${rejected ? 'rejected' : 'successful'} profile preserves the new account`, async () => {
  storage.set(authKey, session('11111', { musickeyCreateTime: now() }));
  const entered = deferred(), reply = deferred();
  respond = body => body.comm.qq === '11111' ? (entered.resolve(), reply.promise) : profileReply();
  const pending = assert.rejects(plugin.account(), /account changed/); await entered.promise;
  await plugin.qqFinishSignIn(session('22222', { loginType: 1 }));
  reply.resolve(rejected ? rejectedProfile(104401) : profileReply()); await pending;
  assert.equal(storage.get(authKey).musicid, '22222');
});

// A WeChat renewal has the same cancellation boundary as a QQ renewal.
test('late WeChat refresh cannot restore a signed-out account', async () => {
  const original = session('33333', { loginType: 1, device: {}, musickeyCreateTime: now() });
  storage.set(authKey, original);
  const entered = deferred(), reply = deferred();
  respond = body => body.req ? (entered.resolve(), reply.promise) : rejectedProfile(1000);
  const pending = assert.rejects(plugin.account(), /account changed/); await entered.promise;
  plugin.signOut(); reply.resolve(refreshed(original)); await pending;
  assert.equal(storage.has(authKey), false);
});

// Parallel account requests share a renewal, including a rotated refresh token.
test('concurrent renewals share the same request and persist the rotated token', async () => {
  const original = session(); storage.set(authKey, original);
  let logins = 0; const entered = deferred(), reply = deferred();
  respond = body => body.req ? (logins++, entered.resolve(), reply.promise) : profileReply();
  const first = plugin.account(), second = plugin.account(); await entered.promise;
  assert.equal(logins, 1); reply.resolve(refreshed(original));
  await Promise.all([first, second]); await plugin.account();
  assert.equal(logins, 1); assert.equal(storage.get(authKey).refresh_token, 'rotated-11111');
});

// A failure cooldown is scoped to its account and cannot suppress a new account's renewal.
test('renewal cooldown does not transfer to another account', async () => {
  storage.set(authKey, session()); let logins = 0;
  respond = body => {
    if (!body.req) return profileReply();
    logins++;
    return body.comm.qq === '11111' ? Response.json({ code: 0, req: { code: 1000 } }) : refreshed(session('22222'));
  };
  await plugin.account(); await plugin.account(); assert.equal(logins, 1);
  await plugin.qqFinishSignIn(session('22222')); await plugin.account();
  assert.equal(logins, 2); assert.equal(storage.get(authKey).musickey, 'renewed-22222');
});

// The profile-code workaround is exclusive to QQ code 1000, not revoked keys or WeChat.
for (const [loginType, code, keep] of [[2, 1000, true], [2, 104401, false], [1, 1000, false], [1, 104401, false]]) {
  test(`profile rejection ${loginType}/${code} retains credential: ${keep}`, async () => {
    storage.set(authKey, session('11111', { loginType, musickeyCreateTime: now() }));
    storage.set(profileKey, profile('11111'));
    respond = () => rejectedProfile(code);
    assert.deepEqual(await plugin.account(), keep ? profile('11111') : null);
    assert.equal(storage.has(authKey), keep); assert.equal(storage.has(profileKey), keep);
  });
}

// A cached profile from a different account must never be reported for the active account.
test('profile fallback verifies the cached account identity', async () => {
  storage.set(authKey, session('11111', { musickeyCreateTime: now() }));
  storage.set(profileKey, profile('22222')); respond = () => rejectedProfile(1000);
  assert.equal((await plugin.account()).id, '11111');
});

// Completing an old refresh must not clear a newer account's in-flight renewal.
test('old refresh completion leaves the new shared renewal intact', async () => {
  const firstReply = deferred(), secondReply = deferred(), firstEntered = deferred(), secondEntered = deferred();
  let secondLogins = 0;
  storage.set(authKey, session());
  respond = body => {
    if (!body.req) return profileReply();
    if (body.comm.qq === '11111') { firstEntered.resolve(); return firstReply.promise; }
    secondLogins++; secondEntered.resolve(); return secondReply.promise;
  };
  const old = assert.rejects(plugin.account(), /account changed/); await firstEntered.promise;
  plugin.signOut(); await plugin.qqFinishSignIn(session('22222'));
  const next = plugin.account(); await secondEntered.promise;
  firstReply.resolve(refreshed(session())); await old;
  const parallel = plugin.account();
  assert.equal(secondLogins, 1); secondReply.resolve(refreshed(session('22222')));
  await Promise.all([next, parallel]); assert.equal(storage.get(authKey).musicid, '22222');
});

// A transport error containing credentials must never put them in the log.
test('refresh failure logging omits raw transport errors', async () => {
  storage.set(authKey, session()); const logs = [], warn = console.warn;
  console.warn = value => logs.push(value);
  respond = body => { if (body.req) throw new Error('secret-fixture-token in request'); return profileReply(); };
  try { await plugin.account(); } finally { console.warn = warn; }
  assert.equal(logs.length, 1); assert.doesNotMatch(logs.join(' '), /secret-fixture-token/);
});
