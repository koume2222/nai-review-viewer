#!/usr/bin/env python3
"""번역 빠짐 점검: 영어·일본어 화면에 한글이 남는지, 서버 문구 T('…')가 사전에 다 있는지 본다.

  python tools/check_i18n.py      (빠진 것이 없으면 종료 코드 0)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import review_viewer as rv   # noqa: E402

KEEP = ('한국어', '불프하르트')   # 어느 언어에서나 그대로 두는 글자
HANGUL = re.compile('[가-힣]')


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    return re.sub(r'(^|\s)//.*$', '', text, flags=re.M)


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    bad = 0
    for lang in ('en', 'ja'):
        rv.LANG = lang
        for name in ('index.html', 'app.js'):
            for no, line in enumerate(strip_comments(rv.ui_text(name)).splitlines(), 1):
                rest = line
                for k in KEEP:
                    rest = rest.replace(k, '')
                if HANGUL.search(rest):
                    bad += 1
                    print(f'[{lang}] {name}: {line.strip()[:200]}')
    src = (ROOT / 'review_viewer.py').read_text(encoding='utf-8')
    keys = {row[0] for row in rv._i18n('server.txt')}
    for m in re.finditer(r"\bT\(\s*'((?:[^'\\]|\\.)*)'", src):
        text = m.group(1).encode().decode('unicode_escape').encode('latin-1').decode('utf-8') if '\\' in m.group(1) else m.group(1)
        if HANGUL.search(text) and text not in keys:
            bad += 1
            print(f'[server] {text}')
    for name in ('ui.txt', 'server.txt'):
        for row in rv._i18n(name):
            if len(row) != 3:
                bad += 1
                print(f'[{name}] 세 줄 묶음이 아님: {row[:1]}')
    # Guide.html must work offline via file://, so it embeds the CLI's prompt templates.
    guide = (ROOT / 'Guide.html').read_text(encoding='utf-8')
    prompts, _ = json.JSONDecoder().raw_decode(guide.split('var T = ', 1)[1])
    for lang in rv.LANGS:
        template = (ROOT / 'i18n' / f'llm-prompt.{lang}.txt').read_text(encoding='utf-8')
        if prompts.get(lang) != template:
            bad += 1
            print(f'[Guide.html] llm-prompt.{lang}.txt 불일치')
    print('빠진 번역 없음' if not bad else f'빠진 번역 {bad}건')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
