import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/locales', { recursive: true });
await build({ entryPoints: ['index.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2020', outfile: 'dist/index.js', legalComments: 'inline' });
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
manifest.main = 'index.js';
await writeFile('dist/plugin.json', JSON.stringify(manifest, null, 2) + '\n');
for (const [source, target] of [
  ['locales/zh-CN.json', 'locales/zh-CN.json'], ['LICENSE', 'LICENSE'],
  ['README.md', 'README.md'], ['NOTICE.md', 'NOTICE.md'], ['web-reference.LICENSE', 'web-reference.LICENSE'],
  ['qrc-des.LICENSE', 'qrc-des.LICENSE'], ['qrc-pako.LICENSE', 'qrc-pako.LICENSE'],
  ['node_modules/jsqr/LICENSE', 'jsqr.LICENSE'], ['node_modules/jpeg-js/LICENSE', 'jpeg-js.LICENSE'],
  ['node_modules/pako/LICENSE', 'pako.LICENSE'],
]) await copyFile(source, 'dist/' + target);
