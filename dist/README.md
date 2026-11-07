# QQ 音乐 · 微信扫码版 for MyGo Music

当前版本 **0.3.2**，需要 MyGo Music **0.1.20+**。默认使用微信扫码登录，直接连接腾讯服务；无需 API 服务、Cookie 手动配置、Node 后台或 ffmpeg。

基于 [Amamiya23/mygo-music-qq-plugin](https://github.com/Amamiya23/mygo-music-qq-plugin) 的 0.3.0 修改。接口兼容处理也参考了 [dddaniel1/mygo-plugin-qqmusic](https://github.com/dddaniel1/mygo-plugin-qqmusic) 和 Lyrics / QQMusicClient 项目。完整来源与许可证见 [NOTICE.md](NOTICE.md)。

## 安装和登录

在 MyGo 中选择「设置 → 插件 → + → 从 GitHub」，输入：

```text
Lorpaves/mygo-music-qqmusic
```

也可以使用安装链接 `mygo-music://install-plugin?repo=Lorpaves/mygo-music-qqmusic`，或从 [Releases](https://github.com/Lorpaves/mygo-music-qqmusic/releases/latest) 下载 `plugin.zip`，在 MyGo 中选择从本地 ZIP 安装。安装包适用于 MyGo 支持的各平台，无需安装 npm 依赖。安装完成后选择 QQ 音乐并按提示允许所列腾讯域名。

从源码安装时，使用仓库中的 `dist` 文件夹；其中已包含构建产物。插件 ID 为 `qqmusic`，与同 ID 的其他 QQ 音乐插件共用安装位置，请勿并存。

1. 在左上角音乐源中选择 **QQ 音乐**。
2. 点击左下角「登录 QQ 音乐」，再点击「登录」。
3. 用**微信扫一扫**扫描应用中的二维码，在手机上确认。
4. 成功后显示昵称并加载歌单；重启会保留登录状态。

「扫码登录方式」留空就是微信，也接受 `wechat`、`wx` 或 `微信`。如需手机 QQ 扫码，填入 `QQ` 再登录。二维码过期后点击重试；取消或拒绝登录不会覆盖已经保存的账号。MyGo 0.1.20 关闭登录窗口后仍可能完成已经确认的登录，退出账号则会使正在进行的登录失效。

## 功能

- 搜索歌曲、歌手、专辑和歌单；搜索建议和翻页。
- 精选歌单、排行榜、专辑和歌手页面、评论读取。
- 微信登录后读取自建歌单、收藏歌单、我喜欢、收藏专辑和个人推荐。
- MP3 标准 / 高音质和 FLAC 无损播放；按 MyGo 中选择的音质请求，无法获取高音质时降级，并返回实际音质。
- QQ 音乐逐字歌词、翻译；没有逐字歌词时使用普通 LRC。
- 保留上游的喜欢歌曲、收藏专辑、歌单编辑和私人电台功能。

歌曲是否可播放、能否使用无损取决于账号权益和地区版权；插件使用 QQ 音乐返回的音源。匿名时未取得音源会提示登录。搜索主接口返回 2001 时改用公开 Web 接口，其中歌手 / 专辑回退结果来自歌曲元数据。

## 相对上游的改动

- 将默认登录方式改为微信，增加准备二维码的中文提示。
- 登录状态先校验再保存；退出或新一轮登录会使旧登录请求失效。
- 为不稳定的桌面搜索接口增加 Web 搜索回退。
- 参考 Lyrics 的 `QMMusicService`，兼容播放结果的 `wifiurl`；CDN 未给域名时使用 QQ 音乐音频域名。
- 兼容不带 `dirType` 的当前歌单接口，自建歌单归入「我的歌单」，「我喜欢」等系统歌单禁止改名或删除。
- 将收藏专辑接口返回的 Unix 时间戳转换为日期字符串，兼容 MyGo 的专辑类型。
- 增加对应回归测试及只读在线检查脚本。

## 验证

2026-11-07：在 MyGo Music 0.1.20 中实际完成微信扫码授权。匿名及登录态的搜索、首页、榜单、整份歌单、专辑、歌手、歌词、评论均通过接口检查；登录态歌单、喜欢、收藏专辑以及三档音质均通过检查。检查音频时验证了真实 CDN 的音频数据，而非只检查 URL。

收藏专辑页面已在 MyGo 中实际验证正常加载。

离线测试 **70 项通过，3 项按上游设置跳过**；跳过项是两项可选 MoeJS 独立测试和一项上游在线测试，实际 MyGo 加载及 `live.mjs` 在线测试另行完成。账号写入操作使用模拟响应验证，没有为测试创建、改名、删除线上歌单或改动收藏。

## 开发

```sh
npm ci
npm test
npm run build
npm run check
npm run test:live
npm run test:signed-in
python3 scripts/package.py
```

`index.js` 为源码，MyGo 加载 `dist/index.js`。修改源码后必须重新构建并重启 MyGo。`python3 scripts/package.py` 将 `dist` 打包为仓库根目录的 `plugin.zip`。

在线登录态测试需将源码放在 MyGo 的 `plugins/qqmusic` 中并先登录；它只在本机读取 `plugin-data/qqmusic/storage.json`，所有测试存储写入都在内存中，不打印凭据、个人歌单标题或带签名的播放地址。

## 登录数据

账号凭据沿用 MyGo 的 `host.storage`，保存在本机 `plugin-data/qqmusic/storage.json`，不在插件源码或安装包中。这是本机明文存储，并非系统钥匙串；凭据只用于腾讯服务请求。退出登录删除本地凭据，不会主动撤销手机端或腾讯服务端其他会话。

## 许可证

AGPL-3.0。保留上游和所使用依赖的许可证。此项目与腾讯、QQ 音乐及微信无隶属关系。
