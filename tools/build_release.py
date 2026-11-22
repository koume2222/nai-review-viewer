#!/usr/bin/env python3
"""릴리스용 포터블 zip을 만든다 — 압축을 풀고 NAI-Review-Viewer.bat만 누르면 도는 묶음(런타임 포함).

  Install.bat                                 (runtime\\ 이 없으면 먼저 한 번)
  runtime\\python.exe tools\\build_release.py   → dist\\nai-review-viewer-<버전>-win64.zip

개인 기록·설정(data, config.local.json, _local)과 개발 부산물은 넣지 않는다.
"""
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_TOP = {'data', '_local', 'dist', '.git', '.github', '.gitignore', '.gitattributes', 'config.local.json', 'runtime.partial'}
EXCLUDE_ANY = {'__pycache__', '_검수결과'}


def main():
    if not (ROOT / 'runtime' / 'python.exe').exists():
        sys.exit('runtime\\python.exe가 없습니다. Install.bat을 먼저 실행하세요.')
    version = re.search(r"^VERSION = '([^']+)'", (ROOT / 'review_viewer.py').read_text(encoding='utf-8'), re.M).group(1)
    out = ROOT / 'dist' / f'nai-review-viewer-{version}-win64.zip'
    out.parent.mkdir(exist_ok=True)
    files = [p for p in sorted(ROOT.rglob('*'))
             if p.is_file() and p.relative_to(ROOT).parts[0] not in EXCLUDE_TOP
             and not EXCLUDE_ANY.intersection(p.relative_to(ROOT).parts) and p.suffix != '.pyc']
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, Path('NAI-Review-Viewer') / p.relative_to(ROOT))
    print(f'{out}  ({len(files)}개 파일, {out.stat().st_size / 1048576:.1f} MB)')


if __name__ == '__main__':
    main()
