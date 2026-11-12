# Changelog

## 0.3.3 — 2026-11-12

- Renew QQ scan sessions from their refresh token before the three-day credential expires, persisting rotated tokens and backing off after failed renewals.
- Prevent late refresh and profile responses from restoring a signed-out account or overwriting a newly selected account.
- Scope concurrent refreshes and retry cooldowns to the active account; verify that QQ refresh responses retain the same account identity.
- Restrict the cached-profile workaround to unexpired QQ scan sessions rejected with code `1000`; revoked credentials and WeChat sessions still sign out.
- Keep raw transport errors out of refresh logs so request credentials cannot be exposed there.
- Preserve WeChat login business codes and report the `20279` device-limit rejection with account-management guidance.

## 0.3.2 — 2026-11-07

First public release of this derivative, based on Amamiya23/mygo-music-qq-plugin 0.3.0.

- Default to WeChat QR login, with Chinese prompts and protection against stale login requests.
- Fall back to QQ Music's public Web search when the desktop endpoint rejects a request.
- Support `wifiurl` playback responses and the QQ Music HTTPS audio CDN fallback.
- Correctly classify owned and system playlists when `dirType` is absent.
- Convert saved-album Unix timestamps to date strings accepted by MyGo, preserving the China release day.
- Include a standalone cross-platform `plugin.zip`, source, licenses, regression tests and read-only live checks.
