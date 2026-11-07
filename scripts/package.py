"""Package the standalone MyGo plugin after `npm run build` (Python 3)."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
manifest = json.loads((dist / 'plugin.json').read_text())
assert manifest['main'] == 'index.js'
assert manifest['version'] == json.loads((root / 'plugin.json').read_text())['version']
assert manifest['version'] == json.loads((root / 'package.json').read_text())['version']
# An allowlist keeps local account state and development files out of releases.
files = ['plugin.json', 'index.js', 'locales/zh-CN.json', 'README.md', 'NOTICE.md',
         'LICENSE', 'web-reference.LICENSE', 'qrc-des.LICENSE', 'qrc-pako.LICENSE',
         'jsqr.LICENSE', 'jpeg-js.LICENSE', 'pako.LICENSE']
with ZipFile(root / 'plugin.zip', 'w', compression=ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(dist / name, name)
with ZipFile(root / 'plugin.zip') as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(files)
print(f"plugin.zip: v{manifest['version']}, {len(files)} files")
