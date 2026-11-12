# Changelog

## Unreleased

- Keep QQ scan logins alive: a musickey is renewed from the stored `refresh_token` a day before it expires, instead of waiting for the three-day TTL to lapse into `QQ Music UrlGetVkey: 0/1000`.
- Persist the `refresh_token` returned by every renewal, retry at most once per ten minutes, and keep playing anonymously when a renewal fails.
- Stop treating a profile request rejected with `1000` as a signed-out account: an unexpired QQ session falls back to the cached profile instead of being deleted.

## 0.3.2 — 2026-11-07

First public release of this derivative, based on Amamiya23/mygo-music-qq-plugin 0.3.0.

- Default to WeChat QR login, with Chinese prompts and protection against stale login requests.
- Fall back to QQ Music's public Web search when the desktop endpoint rejects a request.
- Support `wifiurl` playback responses and the QQ Music HTTPS audio CDN fallback.
- Correctly classify owned and system playlists when `dirType` is absent.
- Convert saved-album Unix timestamps to date strings accepted by MyGo, preserving the China release day.
- Include a standalone cross-platform `plugin.zip`, source, licenses, regression tests and read-only live checks.
