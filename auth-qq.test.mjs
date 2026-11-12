import { test } from "node:test";
import assert from "node:assert/strict";
import { qqSignIn, refreshQQSession } from "./auth-qq.js";

const code = "ABCDEF0123456789ABCDEF0123456789";
const callback = "https://ssl.ptlogin2.graph.qq.com/check_sig?x=1";
const jsonp = (state, url = "") => "ptuiCB('" + state + "','0','" + url + "','0','message','nick');";
function fixture(settings = {}) {
  const calls = [], prompts = [], sleeps = [];
  let polls = 0;
  const headers = (values = {}) => ({
    get: key => values[key.toLowerCase()] || null,
    getSetCookie: () => values.cookies || [],
  });
  const response = (status, body = "", values = {}) => ({
    status, headers: headers(values), text: async () => body,
    json: async () => typeof body === "string" ? JSON.parse(body) : body,
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  });
  const deps = {
    prompt: async value => { prompts.push(value); },
    sleep: async value => { sleeps.push(value); },
    decodeQR: async bytes => { assert.deepEqual([...bytes], [137, 80, 78, 71]); return "qq-qr-content"; },
    fetch: async (address, options) => {
      const url = new URL(address);
      calls.push({ url, options });
      assert.equal(options.redirect, "manual");
      if (url.pathname.endsWith("ptqrshow")) return response(200, "", { cookies: settings.noSig ? [] : ["qrsig=abc123; Domain=.ptlogin2.qq.com; Path=/"] });
      if (url.pathname.endsWith("ptqrlogin")) {
        assert.equal(options.headers.Cookie, "qrsig=abc123");
        assert.equal(url.searchParams.get("ptqrtoken"), "1768482556");
        const value = (settings.statuses || ["66", "67", "0"])[polls++] || "66";
        return response(200, value === "bad" ? "ptuiCB(alert(1));" : jsonp(value, value === "0" ? (settings.callback || callback) : ""));
      }
      if (url.pathname === "/check_sig") return response(302, "", { location: settings.jump || "https://graph.qq.com/oauth2.0/login_jump", cookies: settings.noCookies ? [] : ["p_uin=o123; Domain=.graph.qq.com; Path=/", "p_skey=secret; Domain=graph.qq.com; Path=/", "pt_oauth_token=token; Domain=graph.qq.com; Path=/"] });
      if (url.pathname === "/oauth2.0/login_jump") return response(200);
      if (url.pathname === "/oauth2.0/authorize") {
        assert.equal(options.headers.Cookie, "p_uin=o123; p_skey=secret; pt_oauth_token=token");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("g_tk"), "461122539");
        return response(302, "", { location: "https://y.qq.com/portal/wx_redirect.html?code=" + code + "&state=" + encodeURIComponent(settings.wrongState ? "wrong" : form.get("state")) });
      }
      if (url.hostname === "u.y.qq.com") {
        assert.equal(JSON.parse(options.body).req.param.code, code);
        return response(200, settings.result || { code: 0, req: { code: 0, data: { musicid: 12345, musickey: "Q_test", loginType: 2, nick: "User", keyExpiresIn: "3600" } } });
      }
      throw new Error("unexpected request " + address);
    },
  };
  return { deps, calls, prompts, sleeps };
}

test("QR login exchanges the decoded image and QQ cookies for a session", async () => {
  const f = fixture();
  assert.deepEqual(await qqSignIn(f.deps), { musicid: "12345", musickey: "Q_test", loginType: 2, nick: "User", keyExpiresIn: 3600 });
  assert.deepEqual(f.prompts, [{ qr: "qq-qr-content", text: "请使用手机 QQ 扫码登录" }]);
  assert.deepEqual(f.sleeps, [2000, 2000]);
  assert.equal(f.calls.length, 8);
});

test("rejects expired, invalid and untrusted QR responses", async () => {
  for (const [settings, pattern] of [
    [{ noSig: true }, /signature/], [{ statuses: ["65"] }, /expired/],
    [{ statuses: ["bad"] }, /malformed/], [{ statuses: ["9"] }, /status 9/],
    [{ statuses: ["0"], callback: "https://evil.example/check_sig" }, /redirect/],
    [{ statuses: ["0"], jump: "https://evil.example/oauth2.0/login_jump" }, /redirect/],
    [{ statuses: ["0"], noCookies: true }, /cookies/],
    [{ statuses: ["0"], wrongState: true }, /state/],
  ]) await assert.rejects(qqSignIn(fixture(settings).deps), pattern);
});

test("rejects bad session responses and bounds polling", async () => {
  for (const result of [
    { code: 1, req: { code: 0 } },
    { code: 0, req: { code: 0, data: { musicid: 0, musickey: "x", loginType: 2 } } },
    { code: 0, req: { code: 0, data: { musicid: "1", musickey: "x; y", loginType: 2 } } },
    { code: 0, req: { code: 0, data: { musicid: "1", musickey: "x", loginType: 1 } } },
  ]) await assert.rejects(qqSignIn(fixture({ statuses: ["0"], result }).deps));
  const f = fixture({ statuses: ["66"] });
  await assert.rejects(qqSignIn(f.deps), /expired/);
  assert.equal(f.sleeps.length, 59);
});

test("refreshQQSession renews a QQ scan session and keeps the returned token", async () => {
  const calls = [], now = Math.floor(Date.now() / 1000);
  const fetch = async (address, options) => {
    calls.push({ address, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ code: 0, req: { code: 0, data: { musicid: 12345,
      musickey: "Q_new", loginType: 2, refresh_token: "rotated", unionid: "union-id",
      musickeyCreateTime: now, keyExpiresIn: 3600 } } }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const next = await refreshQQSession({ musicid: "12345", musickey: "Q_old", loginType: 2,
    openid: "open-id", unionid: "union-id", refresh_token: "token-1" }, fetch);
  assert.deepEqual(next, { musicid: "12345", musickey: "Q_new", loginType: 2,
    openid: "open-id", unionid: "union-id", refresh_token: "rotated",
    musickeyCreateTime: now, keyExpiresIn: 3600 });
  const [call] = calls;
  assert.equal(call.address, "https://u.y.qq.com/cgi-bin/musicu.fcg");
  assert.equal(call.body.comm.tmeLoginType, 2);
  assert.equal(call.body.comm.qq, "12345");
  assert.equal(call.body.req.module, "music.login.LoginServer");
  assert.equal(call.body.req.method, "Login");
  assert.equal(call.body.req.param.refresh_token, "token-1");
  assert.equal(call.body.req.param.str_musicid, "12345");
  assert.match(call.options.headers.Cookie, /qm_keyst=Q_old/);
});

test("refreshQQSession refuses to run without a refresh token and reports rejections", async () => {
  await assert.rejects(() => refreshQQSession({ musicid: "12345", musickey: "Q_old", loginType: 2 }, async () => {
    throw new Error("unexpected request");
  }), /no refresh token/);
  const fetch = async () => new Response(JSON.stringify({ code: 0, req: { code: 1000, data: null } }),
    { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => refreshQQSession({ musicid: "12345", musickey: "Q_old", loginType: 2,
    refresh_token: "spent" }, fetch), /QQ refresh rejected: 0\/1000/);
});

// A renewal may rotate credentials, but it must not switch the authenticated account.
test('refreshQQSession rejects a response for another account', async () => {
  const fetch = async () => Response.json({ code: 0, req: { code: 0, data: { musicid: '99999', musickey: 'fixture', loginType: 2 } } });
  await assert.rejects(refreshQQSession({ musicid: '12345', musickey: 'old-fixture', refresh_token: 'fixture' }, fetch), /account mismatch/);
});
