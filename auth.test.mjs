import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as auth from './index.js';
const storage = new Map();
let calls;
let reply;
globalThis.host = {
  storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
};
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(reply), { status: 200 });
};
const ok = info => ({ code: 0, req_0: { code: 0, data: { info } } });
const qq = { musicid: '12345', musickey: 'Q_H_L_test', loginType: 2 };
beforeEach(() => { storage.clear(); calls = []; reply = ok({ nick: "Listener", headurl: "https://example.com/avatar" }); });

test("QQ login validates, persists and authenticates requests", async () => {
  assert.deepEqual(await auth.qqFinishSignIn(qq), { id: "12345", name: "Listener", imageUrl: "https://example.com/avatar" });
  assert.deepEqual(auth.qqReadSession(), { musicid: "12345", musickey: "Q_H_L_test", loginType: 2 });
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.comm.authst, "Q_H_L_test");
  assert.equal(request.comm.qq, "12345");
  assert.equal(request.comm.tmeLoginType, 2);
  assert.match(calls[0].options.headers.Cookie, /qm_keyst=Q_H_L_test/);
  assert.equal((await auth.account()).id, "12345");
  auth.signOut();
  assert.equal(await auth.account(), null);
});

test("failed login does not replace the previous session", async () => {
  await auth.qqFinishSignIn(qq);
  reply = { code: 0, req_0: { code: 104401 } };
  await assert.rejects(() => auth.qqFinishSignIn(qq));
  assert.equal(auth.qqReadSession().musicid, "12345");
});

test("account removes rejected credentials but preserves them on transient failures", async () => {
  await auth.qqFinishSignIn(qq);
  reply = { code: 1, req_0: { code: 0 } };
  await assert.rejects(auth.account);
  assert.ok(auth.qqReadSession());
  reply = { code: 0, req_0: { code: 104401 } };
  assert.equal(await auth.account(), null);
  assert.equal(auth.qqReadSession(), null);
});

test("missing and malformed sessions cannot authenticate", async () => {
  assert.equal(auth.qqAuthContext(), null);
  await assert.rejects(() => auth.qqAuthRpc("m", "n", {}), { code: "signIn" });
  storage.set("qqmusic.auth.v1", { musicid: "123", musickey: "Q_test;other=x", loginType: 2 });
  assert.equal(auth.qqReadSession(), null);
  assert.equal(calls.length, 0);
});

test("WeChat credentials retain their login type", async () => {
  const wechat = { musicid: '12345', musickey: 'W_test', loginType: 1, refresh_key: 'refresh' };
  await auth.qqFinishSignIn(wechat);
  assert.deepEqual(auth.qqReadSession(), wechat);
  assert.equal(JSON.parse(calls[0].options.body).comm.tmeLoginType, 1);
});
