#!/usr/bin/env python3
"""NAI 검수 뷰어 — 로컬 서버 + 내보내기 CLI.

  python review_viewer.py [폴더]                      뷰어 실행(브라우저 창이 열린다)
  python review_viewer.py export <폴더> [--print md|json]   검수 결과를 <폴더>/_검수결과/에 쓴다

검수 기록은 data/review.db(SQLite)에 절대 경로 기준으로 쌓이므로, 상위·하위 어느 폴더를 열어도 같은 체크가 보인다.
체크·'본 것' 기록은 그때의 파일 수정 시각과 함께 저장한다. 재생성 등으로 파일이 바뀌면 다시 '안 본 것'이 된다.
"""
import argparse
import datetime
import errno
import gzip
import hashlib
import http.client
import importlib.util
import json
import math
import os
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import ExifTags, Image, ImageDraw, ImageFilter, PngImagePlugin

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / 'static'
DB_PATH = Path(os.environ.get('NAI_REVIEW_DB') or APP_DIR / 'data' / 'review.db')
CACHE_DIR = Path(os.environ.get('LOCALAPPDATA') or APP_DIR) / 'nai-review-viewer' / 'thumbs'
IMG_EXT = {'.png', '.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.avif'}
THUMB_SIZES = (256, 512, 768, 1024)
MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8'}

VERSION = '1.0.0'
# config.local.json이 있으면 그것을 쓴다(개인 설정 — 업데이트로 config.json이 바뀌어도 유지된다).
CFG_PATH = Path(os.environ.get('NAI_REVIEW_CONFIG') or APP_DIR / 'config.local.json')
if not os.environ.get('NAI_REVIEW_CONFIG') and not CFG_PATH.exists():
    CFG_PATH = APP_DIR / 'config.json'
try:
    CFG = json.loads(CFG_PATH.read_text(encoding='utf-8-sig'))
    TAGS = {t['id']: t for t in CFG['tags']}
    SET_RX = re.compile(CFG['set_suffix_regex'])
    if any('label' not in tag or 'kind' not in tag for tag in TAGS.values()):
        raise ValueError('Each tag needs a label and kind.')
except (OSError, ValueError, KeyError, TypeError, re.error) as exc:
    message = f'Cannot load {CFG_PATH}. Check the JSON settings and required fields. ({exc})'
    if __name__ == '__main__':
        sys.exit(message)
    raise ValueError(message) from exc
# 내보내기 폴더·파일 이름(기본은 영문, config에서 바꾼다)
EXPORT_DIRNAME = CFG.get('export_dirname', '_review')
EXPORT_NAME = CFG.get('export_name', 'review')
EXPORT_LATEST = CFG.get('export_latest', 'review-latest')

# ───────────────────────── 언어 ─────────────────────────
# 원문은 한국어. 다른 언어는 i18n/server.txt(서버 문구)·i18n/ui.txt(화면 문구)의 사전으로 바꾼다.
LANGS = ('ko', 'en', 'ja')
I18N_DIR = APP_DIR / 'i18n'
SETTINGS_PATH = DB_PATH.parent / 'settings.json'


def _os_lang():
    try:
        import ctypes
        primary = ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF
    except (AttributeError, OSError):
        return 'en'
    return {0x12: 'ko', 0x11: 'ja'}.get(primary, 'en')


def _initial_lang():
    saved = None
    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
        if isinstance(settings, dict):
            saved = settings.get('lang')
    except (OSError, ValueError):
        pass
    for cand in (os.environ.get('NAI_REVIEW_LANG'), saved, CFG.get('lang')):
        if cand in LANGS:
            return cand
    return _os_lang()


LANG = _initial_lang()
_TR_CACHE = {}
_LANG_LOCK = threading.Lock()


def set_lang(lang):
    global LANG
    if lang not in LANGS:
        raise ValueError(f'unknown language: {lang}')
    if lang != 'ko':
        _i18n('ui.txt')
        _i18n('server.txt')
    with _LANG_LOCK:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.NamedTemporaryFile(dir=SETTINGS_PATH.parent, delete=False)
        try:
            with tmp:
                tmp.write(json.dumps({'lang': lang}).encode('utf-8'))
            os.replace(tmp.name, SETTINGS_PATH)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        LANG = lang


def _i18n(name):
    """사전 파일(.txt): 세 줄(한국어 / English / 日本語)이 한 묶음, 묶음 사이는 빈 줄, ';;'로 시작하면 주석."""
    path = I18N_DIR / name
    try:
        key = path.stat().st_mtime_ns
    except FileNotFoundError as exc:
        raise FileNotFoundError(f'Missing i18n/{name}. Restore the i18n folder from the viewer package.') from exc
    if _TR_CACHE.get(name, (None,))[0] != key:
        rows, cur = [], []
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.startswith(';;'):
                continue
            if line == '':
                if cur:
                    rows.append(cur)
                cur = []
            else:
                cur.append(line)
        if cur:
            rows.append(cur)
        if not rows or any(len(row) != len(LANGS) for row in rows):
            raise ValueError(f'Invalid i18n/{name}. Restore the i18n folder from the viewer package.')
        _TR_CACHE[name] = (key, rows)
    return _TR_CACHE[name][1]


def T(text, **kw):
    """서버 문구를 지금 언어로. 사전에 없으면 원문(한국어) 그대로."""
    if LANG != 'ko':
        col = LANGS.index(LANG)
        for row in _i18n('server.txt'):
            if row[0] == text:
                text = row[col]
                break
    return text.format(**kw) if kw else text


def loc(v):
    """config 값이 {ko, en, ja} 꼴이면 지금 언어 것을, 문자열이면 그대로."""
    if isinstance(v, dict):
        return v.get(LANG) or v.get('en') or v.get('ko') or next(iter(v.values()), '')
    return v


def tag_label(tag_id):
    return loc(TAGS[tag_id]['label'])


def tags_public():
    return [{**t, **{k: loc(t[k]) for k in ('label', 'short', 'llm_hint') if k in t}} for t in CFG['tags']]


def ui_text(name):
    """static 파일 본문. 한국어가 아니면 i18n/ui.txt의 긴 문구부터 차례로 바꾼다."""
    text = (STATIC_DIR / name).read_text(encoding='utf-8')
    if LANG != 'ko':
        col = LANGS.index(LANG)
        for row in sorted(_i18n('ui.txt'), key=lambda r: -len(r[0])):
            text = text.replace(row[0], row[col])
    return text


def _censor_backup_dir():
    for name in ('검열원본', 'censor-originals'):
        if (DB_PATH.parent / name).is_dir():
            return DB_PATH.parent / name
    return DB_PATH.parent / ('검열원본' if LANG == 'ko' else 'censor-originals')


CENSOR_BACKUP_DIR = _censor_backup_dir()
DECODE_SEM = threading.BoundedSemaphore(max(2, (os.cpu_count() or 4) - 1))


def norm(p):
    return os.path.normcase(os.path.abspath(p))


def within(path, root):
    return path == root or path.startswith(root.rstrip('\\/') + os.sep)


def path_pair(path):
    return norm(path), norm(os.path.realpath(path))


def inside_open_root(pair, root):
    return within(pair[0], root[0]) and within(pair[1], root[1])


def natkey(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]


def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def fmtime(path):
    return round(os.stat(path).st_mtime, 3)


def same_mtime(recorded, current):
    """기록 당시 수정 시각과 지금이 같은가. 시각 없이 남은 기록은 유효로 본다."""
    return recorded is None or abs(recorded - current) < 0.01


def is_image(path):
    return os.path.splitext(path)[1].lower() in IMG_EXT


# ───────────────────────── 저장소 ─────────────────────────

class Store:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS reviews(key TEXT PRIMARY KEY, path TEXT, tags TEXT, note TEXT, updated TEXT, mtime REAL);
            CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY, at TEXT, mtime REAL);
            CREATE TABLE IF NOT EXISTS recent(root TEXT PRIMARY KEY, at TEXT);
            CREATE TABLE IF NOT EXISTS deleted(key TEXT PRIMARY KEY, path TEXT, tags TEXT, note TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS edits(key TEXT PRIMARY KEY, path TEXT, backup TEXT, first_at TEXT, last_at TEXT, count INTEGER);
        ''')
        for table in ('reviews', 'seen'):
            cols = {r[1] for r in self.db.execute(f'PRAGMA table_info({table})')}
            if 'mtime' not in cols:
                self.db.execute(f'ALTER TABLE {table} ADD COLUMN mtime REAL')

    @staticmethod
    def _range(root):
        prefix = norm(root).rstrip('\\/') + os.sep
        return prefix, prefix[:-1] + chr(ord(os.sep) + 1)

    def _rows(self, sql, root):
        lo, hi = self._range(root)
        with self.lock:
            rows = self.db.execute(sql, (lo, hi)).fetchall()
        return [(k[len(lo):].replace('\\', '/'),) + tuple(rest) for k, *rest in rows]

    def reviews(self, root):
        rows = self._rows('SELECT key, path, tags, note, updated, mtime FROM reviews WHERE key >= ? AND key < ?', root)
        return {rel: {'path': p, 'tags': json.loads(t), 'note': n or '', 'updated': u, 'mtime': m}
                for rel, p, t, n, u, m in rows}

    def seen(self, root):
        return {rel: m for rel, m in self._rows('SELECT key, mtime FROM seen WHERE key >= ? AND key < ?', root)}

    def deleted(self, root):
        rows = self._rows('SELECT key, path, tags, note, at FROM deleted WHERE key >= ? AND key < ?', root)
        return [{'rel': rel, 'path': p, 'tags': json.loads(t), 'note': n or '', 'at': a} for rel, p, t, n, a in rows]

    def set_reviews(self, items):
        """items: [(path, tags, note)] — 태그·메모가 모두 비면 기록을 지운다."""
        at = now_iso()
        with self.lock, self.db:
            for path, tags, note in items:
                key = norm(path)
                if not tags and not note:
                    self.db.execute('DELETE FROM reviews WHERE key = ?', (key,))
                else:
                    self.db.execute('INSERT OR REPLACE INTO reviews VALUES (?, ?, ?, ?, ?, ?)',
                                    (key, os.path.abspath(path), json.dumps(tags, ensure_ascii=False), note, at,
                                     fmtime(path)))

    def set_seen(self, paths, value=True):
        at = now_iso()
        with self.lock, self.db:
            if value:
                self.db.executemany('INSERT OR REPLACE INTO seen VALUES (?, ?, ?)',
                                    [(norm(p), at, fmtime(p)) for p in paths])
            else:
                self.db.executemany('DELETE FROM seen WHERE key = ?', [(norm(p),) for p in paths])

    def record_deleted(self, path):
        key = norm(path)
        with self.lock, self.db:
            row = self.db.execute('SELECT tags, note FROM reviews WHERE key = ?', (key,)).fetchone()
            self.db.execute('INSERT OR REPLACE INTO deleted VALUES (?, ?, ?, ?, ?)',
                            (key, os.path.abspath(path), row[0] if row else '[]', row[1] if row else '', now_iso()))
            self.db.execute('DELETE FROM reviews WHERE key = ?', (key,))
            self.db.execute('DELETE FROM seen WHERE key = ?', (key,))

    def edits(self, root):
        rows = self._rows('SELECT key, path, backup, last_at, count FROM edits WHERE key >= ? AND key < ?', root)
        return {rel: {'path': p, 'backup': b, 'at': a, 'count': c} for rel, p, b, a, c in rows}

    def edit_of(self, path):
        with self.lock:
            row = self.db.execute('SELECT backup, count FROM edits WHERE key = ?', (norm(path),)).fetchone()
        return {'backup': row[0], 'count': row[1]} if row else None

    def record_edit(self, path, backup):
        key, at = norm(path), now_iso()
        with self.lock, self.db:
            row = self.db.execute('SELECT count FROM edits WHERE key = ?', (key,)).fetchone()
            if row:
                self.db.execute('UPDATE edits SET last_at = ?, count = ? WHERE key = ?', (at, row[0] + 1, key))
            else:
                self.db.execute('INSERT INTO edits VALUES (?, ?, ?, ?, ?, 1)', (key, os.path.abspath(path), backup, at, at))

    def drop_edit(self, path):
        with self.lock, self.db:
            self.db.execute('DELETE FROM edits WHERE key = ?', (norm(path),))

    def carry_over(self, path, before, drop=()):
        """파일을 고쳐 쓴 뒤(검열 덧칠·원본 복원): 고치기 전 파일에 유효했던 체크를 새 수정 시각으로 옮기고 '본 것'으로 기록.
        drop의 체크(덧칠로 해결된 '검열 약함')는 뺀다. 고치기 전에 이미 무효(파일 바뀜)였던 체크는 건드리지 않는다."""
        key, at, mt = norm(path), now_iso(), fmtime(path)
        with self.lock, self.db:
            row = self.db.execute('SELECT tags, note, mtime FROM reviews WHERE key = ?', (key,)).fetchone()
            tags, note = [], ''
            if row and same_mtime(row[2], before):
                tags, note = [t for t in json.loads(row[0]) if t not in drop], row[1] or ''
                if tags or note:
                    self.db.execute('UPDATE reviews SET tags = ?, updated = ?, mtime = ? WHERE key = ?',
                                    (json.dumps(tags, ensure_ascii=False), at, mt, key))
                else:
                    self.db.execute('DELETE FROM reviews WHERE key = ?', (key,))
            self.db.execute('INSERT OR REPLACE INTO seen VALUES (?, ?, ?)', (key, at, mt))
        return {'tags': tags, 'note': note, 'mtime': mt}

    def touch_recent(self, root):
        with self.lock, self.db:
            self.db.execute('INSERT OR REPLACE INTO recent VALUES (?, ?)', (os.path.abspath(root), now_iso()))

    def recent(self, limit=15):
        with self.lock:
            rows = self.db.execute('SELECT root FROM recent ORDER BY at DESC LIMIT ?', (limit,)).fetchall()
        return [r for (r,) in rows if os.path.isdir(r)]


STORE = None


# ───────────────────────── 스캔 ─────────────────────────

def scan(root):
    """root 아래 이미지 목록(자연 정렬, 폴더 깊이 우선)과 폴더별 장수."""
    root = os.path.abspath(root)
    resolved_root = norm(os.path.realpath(root))
    files, dirs = [], []

    def walk(path, rel, depth, resolved, ancestors):
        try:
            entries = sorted(os.scandir(path), key=lambda e: natkey(e.name))
        except OSError:
            return 0
        entry = {'rel': rel, 'name': os.path.basename(path) if rel else os.path.basename(root) or root,
                 'depth': depth, 'direct': 0, 'count': 0}
        dirs.append(entry)
        subdirs = []
        for e in entries:
            if e.is_dir(follow_symlinks=False):
                if not e.name.startswith('.') and e.name != EXPORT_DIRNAME:
                    child = os.path.join(resolved, os.path.normcase(e.name))
                    if getattr(e.stat(follow_symlinks=False), 'st_reparse_tag', 0) == stat.IO_REPARSE_TAG_MOUNT_POINT:
                        child = norm(os.path.realpath(e.path))
                    if within(child, resolved_root) and child not in ancestors:
                        subdirs.append((e, child))
                continue
            stem, ext = os.path.splitext(e.name)
            if ext.lower() not in IMG_EXT or not e.is_file():
                continue
            if e.is_symlink() and not within(norm(os.path.realpath(e.path)), resolved_root):
                continue
            st = e.stat()
            set_stem = SET_RX.sub('', stem) or stem
            files.append({'rel': f'{rel}/{e.name}' if rel else e.name, 'dir': rel, 'name': e.name,
                          'ext': ext[1:].lower(), 'size': st.st_size, 'mtime': round(st.st_mtime, 3),
                          'set': f'{rel}/{set_stem}' if rel else set_stem})
            entry['direct'] += 1
        total = entry['direct']
        for s, child in subdirs:
            total += walk(s.path, f'{rel}/{s.name}' if rel else s.name, depth + 1, child, ancestors | {child})
        entry['count'] = total
        return total

    walk(root, '', 0, resolved_root, {resolved_root})
    return {'root': root, 'files': files, 'dirs': [d for d in dirs if d['count'] or not d['rel']]}


def read_list(list_file, existing_only=True):
    """목록 파일 → 이미지 절대 경로들. .json은 nai-autogen manifest(items[].file) 또는 경로 배열, 그 밖은 한 줄에 하나."""
    text = Path(list_file).read_text(encoding='utf-8-sig')
    if list_file.lower().endswith('.json'):
        data = json.loads(text)
        items = data.get('items', []) if isinstance(data, dict) else data
        paths = [x['file'] if isinstance(x, dict) else x for x in items]
    else:
        paths = [ln.strip().strip('"') for ln in text.splitlines()]
    return [os.path.abspath(p) for p in paths if p and is_image(p) and (os.path.isfile(p) or not existing_only)]


def scan_list(list_file, paths=None):
    """목록 모드: 목록에 든 이미지만, 그 공통 상위 폴더를 root로."""
    paths = read_list(list_file) if paths is None else [p for p in paths if os.path.isfile(p)]
    if not paths:
        raise FileNotFoundError(T('목록에 있는 이미지가 없습니다: {path}', path=list_file))
    root = os.path.commonpath([os.path.dirname(p) for p in paths])
    data = scan(root)
    keep = {norm(p) for p in paths}
    data['files'] = [f for f in data['files'] if norm(os.path.join(root, f['rel'])) in keep]
    counts = {}
    for f in data['files']:
        parts = f['dir'].split('/') if f['dir'] else []
        for i in range(len(parts) + 1):
            counts['/'.join(parts[:i])] = counts.get('/'.join(parts[:i]), 0) + 1
    for d in data['dirs']:
        d['count'] = counts.get(d['rel'], 0)
        d['direct'] = sum(1 for f in data['files'] if f['dir'] == d['rel'])
    data['dirs'] = [d for d in data['dirs'] if d['count'] or not d['rel']]
    data['list'] = os.path.abspath(list_file)
    return data


# ───────────────────────── 썸네일 ─────────────────────────

def thumb_path(path, size):
    st = os.stat(path)
    h = hashlib.sha1(f'{norm(path)}|{st.st_size}|{st.st_mtime_ns}|{size}'.encode('utf-8')).hexdigest()
    out = CACHE_DIR / h[:2] / f'{h}.webp'
    if out.exists():
        return out
    with DECODE_SEM:
        with Image.open(path) as im:
            im.draft('RGB', (size, size))
            im.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=2.0)
            if im.mode not in ('RGB', 'RGBA'):
                im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(f'{out.stem}.{threading.get_ident()}.tmp')
            im.save(tmp, 'WEBP', quality=82, method=2)
    os.replace(tmp, out)
    return out


class Warmer:
    """다음 페이지들의 썸네일을 뒤에서 미리 만든다. 새 요청이 오면 이전 요청분은 건너뛴다."""

    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.gen = 0

    def request(self, paths, size):
        self.gen += 1
        gen = self.gen
        for p in paths:
            self.pool.submit(self._one, gen, p, size)

    def _one(self, gen, path, size):
        if gen != self.gen:
            return
        try:
            thumb_path(path, size)
        except (OSError, ValueError):
            pass


WARMER = Warmer()


# ───────────────────────── 메타데이터 ─────────────────────────

def _user_comment(raw):
    if not isinstance(raw, bytes):
        return str(raw)
    head, body = raw[:8], raw[8:]
    if head.startswith(b'UNICODE'):
        for enc in ('utf-16-be', 'utf-16-le'):
            try:
                return body.decode(enc)
            except UnicodeDecodeError:
                pass
    if head.startswith((b'ASCII', b'\x00\x00\x00\x00')):
        return body.decode('utf-8', 'replace')
    return raw.decode('utf-8', 'replace')


def _stealth(im):
    """NAI가 PNG 알파 채널 최하위 비트에 숨겨 둔 메타데이터(텍스트 청크가 지워진 PNG용)."""
    if im.mode != 'RGBA':
        return None
    import numpy as np
    bits = (np.asarray(im.getchannel('A')).T.reshape(-1) & 1).astype(np.uint8)
    if bits.size < 152:
        return None
    sig = np.packbits(bits[:120]).tobytes()
    if sig not in (b'stealth_pngcomp', b'stealth_pnginfo'):
        return None
    n = int.from_bytes(np.packbits(bits[120:152]).tobytes(), 'big')
    data = np.packbits(bits[152:152 + n]).tobytes()
    try:
        if sig == b'stealth_pngcomp':
            data = gzip.decompress(data)
    except (OSError, EOFError):
        return None
    return data.decode('utf-8', 'replace')


def _short(v, limit=20000):
    if isinstance(v, bytes):
        v = v.decode('utf-8', 'replace')
    s = str(v)
    return s if len(s) <= limit else s[:limit] + ' …'


def _json_or_none(s):
    if not isinstance(s, str) or not s.lstrip().startswith('{'):
        return None
    try:
        return json.loads(s)
    except ValueError:
        return None


def _captions(block):
    try:
        return [c.get('char_caption', '') for c in block['caption']['char_captions']]
    except (KeyError, TypeError):
        return []


def read_meta(path):
    st = os.stat(path)
    out = {'file': {'path': os.path.abspath(path), 'size': st.st_size,
                    'mtime': datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')},
           'nai': None, 'exif': {}, 'text': {}, 'meta_source': None}
    user_comment, png_comment, stealth = None, None, None
    with Image.open(path) as im:
        out['file'].update(width=im.width, height=im.height, format=im.format, mode=im.mode)
        for k, v in im.info.items():
            if isinstance(v, str):
                out['text'][k] = _short(v)
        png_comment = im.info.get('Comment')
        exif = im.getexif()
        for k, v in exif.items():
            if k != 0x8769:
                out['exif'][ExifTags.TAGS.get(k, str(k))] = _short(v)
        for k, v in exif.get_ifd(0x8769).items():
            if k == 0x9286:
                v = user_comment = _user_comment(v)
            out['exif'][ExifTags.TAGS.get(k, str(k))] = _short(v)
        if im.format == 'PNG' and not png_comment and not user_comment:
            stealth = _stealth(im)

    # NAI 메타데이터 위치: PNG tEXt 'Comment' · webp/jpg EXIF UserComment{'Comment': JSON 문자열} · PNG 알파 stealth
    outer = _json_or_none(user_comment) or _json_or_none(stealth) or {}
    if stealth:
        out['text']['stealth'] = _short(stealth)
    comment = _json_or_none(outer.get('Comment')) or _json_or_none(png_comment)
    if comment:
        out['meta_source'] = 'png-text' if png_comment else ('exif' if user_comment else 'stealth')
        text = out['text']
        out['nai'] = {
            'prompt': comment.get('prompt') or outer.get('Description') or text.get('Description'),
            'uc': comment.get('uc') or comment.get('negative_prompt'),
            'char_captions': _captions(comment.get('v4_prompt')),
            'char_uc': _captions(comment.get('v4_negative_prompt')),
            'seed': comment.get('seed'),
            'steps': comment.get('steps'),
            'scale': comment.get('scale'),
            'cfg_rescale': comment.get('cfg_rescale'),
            'sampler': comment.get('sampler'),
            'noise_schedule': comment.get('noise_schedule'),
            'size': f"{comment.get('width')}×{comment.get('height')}" if comment.get('width') else None,
            'software': outer.get('Software') or text.get('Software') or out['exif'].get('Model'),
            'source': outer.get('Source') or text.get('Source'),
            'generation_time': outer.get('Generation time') or text.get('Generation time') or text.get('Generation_time'),
        }
    elif text_params := out['text'].get('parameters'):   # A1111·ComfyUI 계열
        out['meta_source'] = 'parameters'
        pos, _, rest = text_params.partition('Negative prompt:')
        out['nai'] = {'prompt': pos.strip(), 'uc': rest.split('\nSteps:')[0].strip() or None,
                      'char_captions': [], 'char_uc': []}
    return out


PROMPT_CACHE = {}


def prompt_text(path):
    key = (norm(path), fmtime(path))
    if key not in PROMPT_CACHE:
        try:
            nai = read_meta(path)['nai'] or {}
        except (OSError, ValueError):
            nai = {}
        PROMPT_CACHE[key] = ' '.join([nai.get('prompt') or '', *nai.get('char_captions', [])]).lower()
    return PROMPT_CACHE[key]


def search_prompts(root, query):
    """쉼표로 나눈 조건을 모두 만족하는 이미지(‘-’로 시작하면 제외 조건)."""
    terms = [t.strip().lower() for t in query.split(',') if t.strip()]
    inc = [t for t in terms if not t.startswith('-')]
    exc = [t[1:].strip() for t in terms if t.startswith('-') and t[1:].strip()]
    files = scan(root)['files']
    paths = [os.path.join(root, f['rel'].replace('/', os.sep)) for f in files]
    with ThreadPoolExecutor(max_workers=6) as ex:
        texts = list(ex.map(prompt_text, paths))
    hits = [f['rel'] for f, t in zip(files, texts) if all(x in t for x in inc) and not any(x in t for x in exc)]
    return {'rels': hits, 'scanned': len(files), 'with_prompt': sum(1 for t in texts if t.strip())}


# ───────────────────────── 휴지통 ─────────────────────────

def recycle(paths):
    """Windows 휴지통으로 보낸다(복원 가능). 휴지통이 없는 드라이브면 Windows가 영구 삭제 경고를 띄운다."""
    if os.name != 'nt':
        raise OSError(T('휴지통 삭제는 Windows에서만 지원합니다'))
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [('hwnd', wintypes.HWND), ('wFunc', wintypes.UINT), ('pFrom', ctypes.c_void_p),
                    ('pTo', ctypes.c_void_p), ('fFlags', ctypes.c_uint16), ('fAnyOperationsAborted', wintypes.BOOL),
                    ('hNameMappings', ctypes.c_void_p), ('lpszProgressTitle', wintypes.LPCWSTR)]

    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_WANTNUKEWARNING = \
        3, 0x4, 0x10, 0x40, 0x400, 0x4000
    joined = '\0'.join(os.path.abspath(p) for p in paths) + '\0\0'
    buf = (ctypes.c_wchar * len(joined))(*joined)
    op = SHFILEOPSTRUCTW(None, FO_DELETE, ctypes.cast(buf, ctypes.c_void_p), None,
                         FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING,
                         False, None, None)
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return rc, bool(op.fAnyOperationsAborted)


# ───────────────────────── 검열 덧칠 ─────────────────────────
# 검열만 약한 컷을 재생성·인페인트 없이 고친다: 블러·모자이크·먹칠을 칠한 영역에만 입혀 같은 파일에 저장한다.
# 처음 고칠 때 원본을 data/검열원본/에 한 번 보관하고(원본 복원 가능), 알파 채널(NAI stealth 메타데이터)과
# EXIF·PNG 텍스트는 그대로 둔다. NAIS3 webp는 무손실이라 무손실로 다시 쓴다(픽셀·메타데이터 보존 확인 2026-11-01).

CENSOR_EXT = {'.png', '.webp', '.jpg', '.jpeg', '.jfif'}
CENSOR_MODES = {'blur': (1, 200), 'mosaic': (2, 256), 'fill': (0, 0)}   # 세기 범위: 블러 = 가우스 표준편차 px, 모자이크 = 칸 크기 px


def _webp_lossless(path):
    with open(path, 'rb') as fh:
        fh.read(12)
        while len(h := fh.read(8)) == 8:
            fourcc, size = h[:4], int.from_bytes(h[4:], 'little')
            if fourcc in (b'VP8L', b'VP8 '):
                return fourcc == b'VP8L'
            fh.seek(size + (size & 1), 1)
    return False


def _censor_effect(rgb, mode, strength):
    """칠할 영역에 들어갈 그림(전체 크기). 화면 미리보기(app.js ceEffect)와 같은 계산."""
    if mode == 'fill':
        return Image.new('RGB', rgb.size, (0, 0, 0))
    if mode == 'blur':
        return rgb.filter(ImageFilter.GaussianBlur(strength))
    import numpy as np
    a = np.asarray(rgb, dtype=np.float64)
    h, w = a.shape[:2]
    ys, xs = np.arange(0, h, strength), np.arange(0, w, strength)
    sums = np.add.reduceat(np.add.reduceat(a, ys, axis=0), xs, axis=1)
    counts = np.outer(np.diff(np.append(ys, h)), np.diff(np.append(xs, w)))[..., None]
    blocks = np.rint(sums / counts).astype(np.uint8)
    return Image.fromarray(np.repeat(np.repeat(blocks, strength, axis=0), strength, axis=1)[:h, :w])


MASK_SS = 4   # 칠한 모양을 4배로 그려 줄인다 — 브라우저 캔버스처럼 가장자리가 부드럽게(안티에일리어싱) 맞물린다


def _censor_mask(size, ops):
    """칠한 모양(L). 사각형은 정수 픽셀 [x0, x1) 범위(app.js ceMask fillRect와 같음).
    부드럽게(feather > 0)면 모양을 가우스로 흐린다 — 묶음 안의 획은 feather가 같다."""
    k = MASK_SS
    m = Image.new('L', (size[0] * k, size[1] * k), 0)
    d = ImageDraw.Draw(m)
    for op in ops:
        pts = [(float(x) * k, float(y) * k) for x, y in op['points']]
        if op['shape'] == 'rect':   # 반올림은 JS Math.round와 같게(.5는 올림 — 파이썬 round는 짝수 쪽)
            (x0, y0), (x1, y1) = [(math.floor(x + 0.5), math.floor(y + 0.5)) for x, y in (op['points'][0], op['points'][-1])]
            x0, x1, y0, y1 = min(x0, x1), max(x0, x1, min(x0, x1) + 1), min(y0, y1), max(y0, y1, min(y0, y1) + 1)
            d.rectangle([x0 * k, y0 * k, x1 * k - 1, y1 * k - 1], fill=255)
            continue
        r = op['size'] * k / 2
        if len(pts) > 1:
            d.line(pts, fill=255, width=max(1, round(op['size'] * k)), joint='curve')
        for x, y in pts:
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    m = m.resize(size, Image.Resampling.BOX)
    feather = ops[0]['feather'] if ops else 0
    return m.filter(ImageFilter.GaussianBlur(feather)) if feather else m


def clean_censor_ops(raw):
    ops = []
    for op in raw[:500]:
        mode, shape = op.get('mode'), op.get('shape', 'brush')
        if mode not in CENSOR_MODES or shape not in ('brush', 'rect'):
            raise ValueError(T('알 수 없는 도구: {tool}', tool=f'{mode}/{shape}'))
        lo, hi = CENSOR_MODES[mode]
        pts = [(float(p[0]), float(p[1])) for p in op.get('points', [])[:20000]]
        if not pts or (shape == 'rect' and len(pts) < 2):
            continue
        ops.append({'mode': mode, 'shape': shape, 'points': pts,
                    'strength': min(hi, max(lo, int(op.get('strength', lo)))),
                    'size': min(2000.0, max(1.0, float(op.get('size', 40)))),
                    'feather': min(100, max(0, int(op.get('feather') or 0)))})
    return ops


def apply_censor(path, ops):
    """ops를 차례로 입혀 같은 파일에 저장. 같은 도구·세기가 이어지는 획은 한 번에 계산한다(겹쳐 칠해도 두 번 흐려지지 않음)."""
    ext = os.path.splitext(path)[1].lower()
    lossless = ext == '.webp' and _webp_lossless(path)
    with Image.open(path) as im:
        im.load()
        info = dict(im.info)
        alpha = im.getchannel('A') if 'A' in im.getbands() else None
        text = dict(getattr(im, 'text', None) or {}) if ext == '.png' else {}
        rgb = im.convert('RGB')
    groups = []
    for op in ops:
        key = (op['mode'], op['strength'], op['feather'])
        if groups and groups[-1][0] == key:
            groups[-1][1].append(op)
        else:
            groups.append((key, [op]))
    for (mode, strength, _), group in groups:
        rgb = Image.composite(_censor_effect(rgb, mode, strength), rgb, _censor_mask(rgb.size, group))
    out = rgb
    if alpha is not None:   # 알파는 원본 그대로(NAI stealth 메타데이터가 최하위 비트에 있다)
        out = rgb.convert('RGBA')
        out.putalpha(alpha)
    keep = {k: info[k] for k in ('exif', 'icc_profile', 'xmp') if info.get(k)}
    tmp = os.path.join(os.path.dirname(path), f'.{os.path.basename(path)}.censor-tmp')
    if ext == '.webp':
        out.save(tmp, 'WEBP', lossless=lossless, quality=100 if lossless else 95, method=4, **keep)
    elif ext == '.png':
        pnginfo = PngImagePlugin.PngInfo()
        for k, v in text.items():
            pnginfo.add_text(k, v)
        out.save(tmp, 'PNG', pnginfo=pnginfo, **{k: v for k, v in keep.items() if k != 'xmp'})
    else:
        out.convert('RGB').save(tmp, 'JPEG', quality=95, subsampling=0, **{k: v for k, v in keep.items() if k != 'xmp'})
    os.replace(tmp, path)


def censor_backup_path(path):
    h = hashlib.sha1(norm(path).encode('utf-8')).hexdigest()[:12]
    return CENSOR_BACKUP_DIR / f'{h}_{os.path.basename(path)}'


def censor_save(path, ops):
    before = fmtime(path)
    ed = STORE.edit_of(path)
    backup = ed['backup'] if ed and os.path.isfile(ed['backup']) else None
    if not backup:
        CENSOR_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        backup = str(censor_backup_path(path))
        shutil.copy2(path, backup)
    apply_censor(path, ops)
    STORE.record_edit(path, backup)
    rev = STORE.carry_over(path, before, drop=('censor',))
    return {**rev, 'size': os.path.getsize(path), 'edits': STORE.edit_of(path)['count']}


def censor_restore(path):
    ed = STORE.edit_of(path)
    if not ed or not os.path.isfile(ed['backup']):
        raise FileNotFoundError(T('보관한 원본이 없습니다'))
    before = fmtime(path)
    tmp = os.path.join(os.path.dirname(path), f'.{os.path.basename(path)}.censor-tmp')
    shutil.copyfile(ed['backup'], tmp)
    os.replace(tmp, path)
    os.remove(ed['backup'])
    STORE.drop_edit(path)
    return {**STORE.carry_over(path, before), 'size': os.path.getsize(path)}


# ───────────────────────── 다른 도구용 조회 ─────────────────────────

def lookup(paths, db_path=DB_PATH):
    """경로마다 지금 유효한 체크·'본 것'·삭제 기록(읽기 전용). nai_autogen.py eyes가 쓴다.

    반환 {경로: {exists, tags, note, seen, stale, deleted, censor_edits}} — 체크 뒤 파일이 바뀌었으면 tags를 비우고 stale=True.
    censor_edits = 뷰어에서 검열을 덧칠해 저장한 횟수(0 = 손대지 않음).
    """
    out = {p: {'exists': os.path.isfile(p), 'tags': [], 'note': '', 'seen': False, 'stale': False, 'deleted': None,
               'censor_edits': 0} for p in paths}
    if not Path(db_path).exists():
        return out
    con = sqlite3.connect(f'file:{Path(db_path).as_posix()}?mode=ro', uri=True)
    try:
        for p, rec in out.items():
            key = norm(p)
            if rec['exists']:
                cur = fmtime(p)
                rv = con.execute('SELECT tags, note, mtime FROM reviews WHERE key = ?', (key,)).fetchone()
                if rv and same_mtime(rv[2], cur):
                    rec['tags'] = [t for t in json.loads(rv[0]) if t in TAGS]
                    rec['note'] = rv[1] or ''
                elif rv:
                    rec['stale'] = True
                sn = con.execute('SELECT mtime FROM seen WHERE key = ?', (key,)).fetchone()
                rec['seen'] = bool(sn) and same_mtime(sn[0], cur)
                if con.execute("SELECT 1 FROM sqlite_master WHERE name = 'edits'").fetchone():
                    ed = con.execute('SELECT count FROM edits WHERE key = ?', (key,)).fetchone()
                    rec['censor_edits'] = ed[0] if ed else 0
            else:
                dl = con.execute('SELECT tags, note, at FROM deleted WHERE key = ?', (key,)).fetchone()
                if dl:
                    rec['deleted'] = {'tags': [t for t in json.loads(dl[0]) if t in TAGS], 'note': dl[1] or '', 'at': dl[2]}
    finally:
        con.close()
    return out


# ───────────────────────── 내보내기 ─────────────────────────

def _kinds(tag_ids):
    return {TAGS[t]['kind'] for t in tag_ids if t in TAGS}


def _llm_meta(path):
    try:
        nai = read_meta(path)['nai']
    except OSError:
        return None
    if not nai:
        return None
    fields = ('seed', 'prompt', 'uc', 'char_captions', 'char_uc')
    return {k: nai[k] for k in fields if nai.get(k) not in (None, '', [])}


def build_export(folder, list_file=None, *, list_root=None):
    paths = read_list(list_file, existing_only=False) if list_file else []
    if list_root and any(not inside_open_root(path_pair(p), list_root) for p in paths if os.path.isfile(p)):
        raise ValueError('The list now points outside the opened folder. Reopen the list.')
    data = scan_list(list_file, paths) if list_file else scan(folder)
    root = data['root']
    if list_file and folder and norm(folder) != norm(root):   # 목록 모드에서 하위 폴더만
        sub = os.path.relpath(folder, root).replace(os.sep, '/')
        data['files'] = [f for f in data['files'] if f['dir'] == sub or f['dir'].startswith(sub + '/')]
    listed = {norm(p) for p in paths} if list_file else None
    revs = STORE.reviews(root)
    seen = STORE.seen(root)
    mtimes = {f['rel'].lower(): f['mtime'] for f in data['files']}

    def review_of(rel):
        r = revs.get(rel.lower())
        return r if r and same_mtime(r['mtime'], mtimes[rel.lower()]) else None

    def is_seen(rel):
        k = rel.lower()
        return k in seen and same_mtime(seen[k], mtimes[k])

    sets = {}
    for f in data['files']:
        sets.setdefault(f['set'], []).append(f)

    items, set_rows, unseen = [], [], []
    count = {'total': len(data['files']), 'seen': 0, 'unseen_unmarked': 0, 'pass_unmarked': 0,
             'reject': 0, 'set_reject': 0, 'keeper': 0, 'more': 0, 'stale': 0}
    by_tag = {t: 0 for t in TAGS}
    for set_key, members in sets.items():
        tag_of = {f['rel']: (review_of(f['rel']) or {}).get('tags', []) for f in members}
        keepers = [f['rel'] for f in members if 'keeper' in _kinds(tag_of[f['rel']])]
        row = {'set': set_key, 'size': len(members), 'keeper': keepers, 'reject': [], 'set_reject': [], 'more': []}
        for f in members:
            rel = f['rel']
            if revs.get(rel.lower()) and not review_of(rel):
                count['stale'] += 1
            r = review_of(rel) or {}
            tags = [t for t in r.get('tags', []) if t in TAGS]
            kinds = _kinds(tags)
            seen_now = is_seen(rel)
            count['seen'] += seen_now
            for t in tags:
                by_tag[t] += 1
            if 'negative' in kinds:
                verdict = 'reject'
            elif 'keeper' in kinds:
                verdict = 'keeper'
            elif 'positive' in kinds:
                verdict = 'more'
            elif keepers:
                verdict = 'set_reject'
            elif r.get('note'):
                verdict = 'pass'
            else:
                if seen_now:
                    count['pass_unmarked'] += 1
                else:
                    count['unseen_unmarked'] += 1
                    unseen.append(rel)
                continue
            if verdict in count:
                count[verdict] += 1
            if 'positive' in kinds and verdict != 'more':
                count['more'] += 1
            if verdict in ('reject', 'set_reject'):
                row[verdict].append(rel)
            if 'positive' in kinds:
                row['more'].append(rel)
            item = {'rel': rel, 'path': os.path.join(root, rel.replace('/', os.sep)), 'set': set_key,
                    'verdict': verdict, 'regen': verdict == 'reject', 'more': 'positive' in kinds,
                    'tags': [tag_label(t) for t in tags], 'tag_ids': tags, 'note': r.get('note', ''),
                    'seen': seen_now, 'updated': r.get('updated')}
            if verdict in ('reject', 'more', 'keeper'):
                item['nai'] = _llm_meta(item['path'])
            items.append(item)
        if keepers or row['reject'] or row['more']:
            set_rows.append(row)

    deleted = []
    for d in STORE.deleted(root):
        if os.path.exists(d['path']) or (listed is not None and norm(d['path']) not in listed):
            continue   # 같은 이름으로 새 파일이 생겼으면 새 파일로 본다 · 목록 모드는 목록에 있던 것만
        tags = [t for t in d['tags'] if t in TAGS]
        deleted.append({'rel': d['rel'], 'tags': [tag_label(t) for t in tags], 'tag_ids': tags,
                        'note': d['note'], 'deleted_at': d['at']})
    count['deleted'] = len(deleted)
    rels = {f['rel'].lower(): f['rel'] for f in data['files']}
    edited = [{'rel': rels[k], 'edits': e['count'], 'last_at': e['at'], 'backup': e['backup']}
              for k, e in STORE.edits(root).items() if k in rels]
    count['censor_edited'] = len(edited)

    return {
        'tool': 'NAI-검수뷰어', 'format': 2, 'exported_at': now_iso(), 'folder': root, 'list': list_file,
        'rules': {
            T('체크 없음'): T('본 이미지는 합격. 안 본 이미지(unseen)는 판정 없음.'),
            'reject': T('부정 사유가 하나라도 있으면 불합격 = 재생성 대상(regen=true).'),
            'keeper': T('세트 중 이것만 합격. 같은 세트의 체크 없는 컷은 set_reject(채택 안 함, 재생성 불필요).'),
            'more': T('합격 + 이 컷 기준으로 비슷하게 추가 생산 요청.'),
            'deleted': T('사용자가 휴지통으로 보낸 파일. 삭제 전 체크가 있으면 tags에 남는다.'),
            'set': T('같은 폴더 + 파일명 끝 변형 번호(_2, _round_NN_N — 0으로 시작하는 _01은 제외)를 뗀 이름이 같으면 한 세트.'),
            'stale': T('체크 뒤 파일이 바뀐(재생성·덮어쓰기) 이미지는 이전 체크를 무시하고 다시 안 본 것으로 센다.'),
            'censor_edited': T('사용자가 뷰어에서 검열(블러·모자이크·먹칠)을 덧칠해 같은 파일에 저장한 이미지. 재생성 불필요 — 파일 자체가 고쳐졌다. 원본은 backup 경로에 있다.'),
        },
        'lang': LANG,
        'tag_defs': [{k: t.get(k) for k in ('id', 'kind', 'label', 'llm_hint')} for t in tags_public()],
        'summary': {**count, 'by_tag': {tag_label(t): n for t, n in by_tag.items() if n}},
        'items': items,
        'sets': set_rows,
        'deleted': deleted,
        'censor_edited': edited,
        'unseen': unseen,
    }


def export_markdown(rep):
    s = rep['summary']
    L = [T('# 검수 결과 — {folder}', folder=rep['folder']), '',
         T('- 내보낸 시각: {at}', at=rep['exported_at']),
         T('- 전체 {total}장 · 본 것 {seen}장 · 체크 없이 합격 {pass_unmarked}장 · 안 본 것 {unseen_unmarked}장', **s),
         T('- **재생성 대상(불합격) {reject}장** · 세트 탈락 {set_reject}장 · 세트 대표 합격 {keeper}장 · 추가 생산 요청 {more}장 · 삭제 {deleted}장', **s)
         + (T(' · 검열 덧칠 {censor_edited}장', **s) if s['censor_edited'] else ''),
         '', T('판정 규칙: 체크 없는 본 이미지 = 합격 · 부정 사유 = 불합격(재생성) · ★대표가 있는 세트의 나머지 = 세트 탈락(재생성 불필요) · +추가 = 합격 + 비슷하게 더 생산.'), '']
    if s['stale']:
        L += [T('- 체크 뒤 파일이 바뀐 이미지 {stale}장은 이전 체크를 무시했다(다시 봐야 함).', **s), '']
    if s['by_tag']:
        L += [T('## 사유별 집계'), '', T('| 사유 | 장수 |'), '|---|---|']
        L += [f'| {k} | {v} |' for k, v in s['by_tag'].items()]
        L.append('')

    def memo(note):
        return T(' — 메모: {note}', note=note) if note else ''

    rejects = [i for i in rep['items'] if i['verdict'] == 'reject']
    if rejects:
        L += [T('## 재생성 대상 (불합격)'), '']
        by_set = {}
        for i in rejects:
            by_set.setdefault(i['set'], []).append(i)
        for set_key, its in by_set.items():
            L.append(f'### {set_key}')
            for i in its:
                seed = f" (seed {i['nai']['seed']})" if i.get('nai') and i['nai'].get('seed') is not None else ''
                L.append(f"- `{i['rel']}` — {', '.join(i['tags'])}{memo(i['note'])}{seed}")
            L.append('')

    keeper_sets = [r for r in rep['sets'] if r['keeper']]
    if keeper_sets:
        L += [T('## 세트 대표 합격 (나머지는 세트 탈락)'), '']
        for r in keeper_sets:
            drop = ', '.join(f'`{x}`' for x in r['set_reject']) or T('없음')
            L.append(T('- {set} ({size}장): 대표 {keeper} · 탈락 {drop}', set=r['set'], size=r['size'],
                       keeper=', '.join(f'`{x}`' for x in r['keeper']), drop=drop))
        L.append('')

    mores = [i for i in rep['items'] if i['more']]
    if mores:
        L += [T('## 추가 생산 요청 (합격 + 비슷하게 더)'), '']
        L += [f"- `{i['rel']}`" + memo(i['note']) for i in mores]
        L.append('')

    notes = [i for i in rep['items'] if i['verdict'] == 'pass' and i['note']]
    if notes:
        L += [T('## 메모만 있는 합격 컷'), '']
        L += [f"- `{i['rel']}` — {i['note']}" for i in notes]
        L.append('')

    if rep['censor_edited']:
        L += [T('## 뷰어에서 검열을 덧칠한 파일 (재생성 불필요)'), '',
              T('블러·모자이크·먹칠을 같은 파일에 저장했다. 원본은 검수 뷰어 `data/{dir}/`에 있다.', dir=CENSOR_BACKUP_DIR.name), '']
        L += [f"- `{e['rel']}`" + (T(' ({n}회 저장)', n=e['edits']) if e['edits'] > 1 else '') for e in rep['censor_edited']]
        L.append('')

    if rep['deleted']:
        L += [T('## 삭제한 파일 (휴지통)'), '']
        for d in rep['deleted']:
            why = ', '.join(d['tags']) + memo(d['note'])
            L.append(f"- `{d['rel']}`" + (f' — {why}' if why else ''))
        L.append('')

    used = {t for i in rep['items'] for t in i['tag_ids']} | {t for d in rep['deleted'] for t in d['tag_ids']}
    hints = [t for t in rep['tag_defs'] if t['id'] in used and t.get('llm_hint')]
    if hints:
        L += [T('## 사유 해설 (프롬프트 수정 참고)'), '']
        L += [f"- **{t['label']}**: {t['llm_hint']}" for t in hints]
        L.append('')
    L.append(T('프롬프트·seed 원문은 같은 이름의 .json 파일 `items[].nai`에 있다.'))
    return '\n'.join(L) + '\n'


def write_export(folder, list_file=None, *, list_root=None):
    rep = build_export(folder, list_file, list_root=list_root)
    md = export_markdown(rep)
    # 목록 모드는 목록 파일 옆에 쓴다(NAIS3 씬 폴더를 건드리지 않게)
    base = Path(list_file).parent if list_file else Path(rep['folder'])
    out_dir = base / EXPORT_DIRNAME
    if not out_dir.resolve().is_relative_to(base.resolve()):
        raise ValueError('Export directory is outside the selected folder.')
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    js = json.dumps(rep, ensure_ascii=False, indent=1)
    outputs = [(out_dir / f'{name}.{ext}', content) for name in (f'{EXPORT_NAME}-{stamp}', EXPORT_LATEST)
               for ext, content in (('json', js), ('md', md))]
    if any(not path.resolve().is_relative_to(out_dir.resolve()) for path, _ in outputs):
        raise ValueError('Export file is outside the results directory.')
    for path, content in outputs:
        path.write_text(content, encoding='utf-8')
    return rep, md, {'json': str(out_dir / f'{EXPORT_LATEST}.json'), 'md': str(out_dir / f'{EXPORT_LATEST}.md')}


# ───────────────────────── HTTP ─────────────────────────

ALLOWED_ROOTS = set()
OPEN_LIST_ROOTS = {}
EXPORTED_REPORTS = {}
try:
    PORT = int(os.environ.get('NAI_REVIEW_PORT') or CFG.get('port', 8765))
    if not 1 <= PORT <= 65535:
        raise ValueError
except (TypeError, ValueError):
    message = 'Set NAI_REVIEW_PORT or the config port to a number from 1 to 65535.'
    if __name__ == '__main__':
        sys.exit(message)
    raise ValueError(message) from None


def allowed(path):
    pair = path_pair(path)
    return any(inside_open_root(pair, root) for root in ALLOWED_ROOTS.copy())


def pick_directory(initial):
    code = ('import sys, tkinter as tk; from tkinter import filedialog; r = tk.Tk(); r.withdraw(); '
            'r.attributes("-topmost", True); p = filedialog.askdirectory(initialdir=sys.argv[1] or None, '
            'title=sys.argv[2]); sys.stdout.write(p or "")')
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    if importlib.util.find_spec('tkinter'):
        res = subprocess.run([sys.executable, '-c', code, initial or '', T('검수할 폴더 선택')], capture_output=True, env=env)
    else:   # 포터블 런타임(임베드 Python)에는 tkinter가 없다 → Windows 폴더 선택 창
        ps = ('Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; '
              '$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:NRV_TITLE; '
              'if ($env:NRV_INITIAL) { $d.SelectedPath = $env:NRV_INITIAL }; '
              '$o = New-Object System.Windows.Forms.Form -Property @{ShowInTaskbar = $false; Opacity = 0}; '
              '$o.Show(); $o.TopMost = $true; '
              'if ($d.ShowDialog($o) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }')
        res = subprocess.run(['powershell', '-NoProfile', '-STA', '-Command', ps], capture_output=True,
                             env={**env, 'NRV_INITIAL': initial or '', 'NRV_TITLE': T('검수할 폴더 선택')})
    p = res.stdout.decode('utf-8', 'replace').strip()
    return os.path.abspath(p) if p else ''


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8',
                   {'Cache-Control': 'no-store'})

    def _error(self, code, msg):
        self.close_connection = True
        self._send(code, msg.encode('utf-8'), 'text/plain; charset=utf-8')

    def _file(self, path, ctype, cache=True):
        body = Path(path).read_bytes()
        self._send(200, body, ctype, {'Cache-Control': 'private, max-age=31536000, immutable' if cache else 'no-cache'})

    def _host_ok(self):
        return self.headers.get('Host', '') in (f'127.0.0.1:{PORT}', f'localhost:{PORT}')

    def _api_origin_ok(self):
        origin = self.headers.get('Origin')
        return (self.headers.get('Sec-Fetch-Site') not in ('cross-site', 'same-site')
                and (origin is None or origin == 'http://' + self.headers['Host']))

    def _image_arg(self, q):
        p = q.get('p', '')
        if not p or not allowed(p) or not is_image(p) or not os.path.isfile(p):
            return None
        return p

    def _paths(self, body):
        """POST의 root + rels → 허용 범위 안의 실제 이미지 경로만."""
        root = body['root']
        out = []
        for rel in body.get('rels', []):
            p = os.path.join(root, rel.replace('/', os.sep))
            if allowed(p) and is_image(p) and os.path.isfile(p):
                out.append((rel, p))
        return out

    def do_GET(self):
        if not self._host_ok():
            return self._error(403, 'bad host')
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        try:
            route = u.path
            if route.startswith('/api/') and not self._api_origin_ok():
                return self._error(403, 'bad origin')
            if route in ('/', '/index.html', '/app.js', '/app.css'):
                name = 'index.html' if route in ('/', '/index.html') else route[1:]
                return self._send(200, ui_text(name).encode('utf-8'), MIME[os.path.splitext(name)[1]],
                                  {'Cache-Control': 'no-store'})
            if route == '/api/ping':
                return self._json({'app': 'nai-review-viewer', 'version': VERSION})
            if route == '/api/config':
                return self._json({'tags': tags_public(), 'lang': LANG, 'langs': LANGS, 'version': VERSION,
                                   'censor_dir': CENSOR_BACKUP_DIR.name, 'default_aspect': CFG.get('default_aspect', 0.7),
                                   'thumb_sizes': THUMB_SIZES})
            if route == '/api/recent':
                return self._json({'recent': STORE.recent()})
            if route == '/api/scan':
                if q.get('list'):
                    if not os.path.isfile(q['list']):
                        return self._error(404, T('목록 파일이 없습니다: {path}', path=q['list']))
                    try:
                        data = scan_list(q['list'])
                    except FileNotFoundError as e:
                        return self._error(404, str(e))
                    root = path_pair(data['root'])
                    OPEN_LIST_ROOTS[path_pair(q['list'])] = root
                    ALLOWED_ROOTS.add(root)
                    return self._json(data)
                root = q.get('root', '')
                if not os.path.isdir(root):
                    return self._error(404, T('폴더가 없습니다: {path}', path=root))
                data = scan(root)
                ALLOWED_ROOTS.add(path_pair(data['root']))
                STORE.touch_recent(data['root'])
                return self._json(data)
            if route == '/api/reviews':
                root = q.get('root', '')
                if not allowed(root):
                    return self._error(403, 'scan first')
                return self._json({'reviews': {k: {'tags': v['tags'], 'note': v['note'], 'mtime': v['mtime']}
                                               for k, v in STORE.reviews(root).items()},
                                   'seen': STORE.seen(root),
                                   'edited': {k: v['count'] for k, v in STORE.edits(root).items()}})
            if route in ('/api/img', '/api/thumb', '/api/meta', '/api/censor-info'):
                p = self._image_arg(q)
                if not p:
                    return self._error(404, 'no image')
                if route == '/api/meta':
                    return self._json(read_meta(p))
                if route == '/api/censor-info':
                    ed = STORE.edit_of(p)
                    return self._json({'editable': os.path.splitext(p)[1].lower() in CENSOR_EXT,
                                       'edits': ed['count'] if ed else 0,
                                       'backup': ed['backup'] if ed and os.path.isfile(ed['backup']) else None})
                if route == '/api/thumb':
                    size = int(q.get('s', 512))
                    if size in THUMB_SIZES:
                        try:
                            return self._file(thumb_path(p, size), 'image/webp')
                        except (OSError, ValueError):
                            pass  # Pillow가 못 여는 형식은 원본으로
                return self._file(p, MIME.get(os.path.splitext(p)[1].lower(), 'application/octet-stream'))
            return self._error(404, 'not found')
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:  # 뷰어가 멈추지 않도록 요청 단위로만 실패시킨다
            try:
                self._error(500, f'{type(e).__name__}: {e}')
            except OSError:
                pass

    def do_POST(self):
        if not self._host_ok():
            return self._error(403, 'bad host')
        if not self._api_origin_ok():
            return self._error(403, 'bad origin')
        if self.headers.get_content_type() != 'application/json':
            return self._error(415, 'json only')
        route = urllib.parse.urlsplit(self.path).path
        try:
            size = int(self.headers.get('Content-Length', 0))
            if size <= 0:
                return self._error(400, 'expected a JSON object')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                return self._error(400, 'expected a JSON object')
            if route == '/api/lang':
                set_lang(body.get('lang'))
                return self._json({'lang': LANG})
            if route == '/api/review':
                root = body['root']
                items = []
                for it in body['items']:
                    p = os.path.join(root, it['rel'].replace('/', os.sep))
                    if allowed(p) and is_image(p) and os.path.isfile(p):
                        items.append((p, [t for t in it.get('tags', []) if t in TAGS], it.get('note', '').strip()))
                STORE.set_reviews(items)
                return self._json({'ok': True, 'saved': len(items)})
            if route == '/api/seen':
                STORE.set_seen([p for _, p in self._paths(body)], body.get('seen', True))
                return self._json({'ok': True})
            if route == '/api/delete':
                targets = self._paths(body)
                if not targets:
                    return self._json({'deleted': [], 'failed': []})
                rc, aborted = recycle([p for _, p in targets])
                deleted, failed = [], []
                for rel, p in targets:
                    if os.path.exists(p):
                        failed.append(rel)
                    else:
                        STORE.record_deleted(p)
                        deleted.append(rel)
                return self._json({'deleted': deleted, 'failed': failed, 'code': rc, 'aborted': aborted})
            if route in ('/api/censor', '/api/censor-restore'):
                found = self._paths({'root': body['root'], 'rels': [body['rel']]})
                if not found or os.path.splitext(found[0][1])[1].lower() not in CENSOR_EXT:
                    return self._error(404, T('고칠 수 없는 파일입니다'))
                p = found[0][1]
                if route == '/api/censor-restore':
                    return self._json(censor_restore(p))
                ops = clean_censor_ops(body.get('ops', []))
                if not ops:
                    return self._error(400, T('칠한 영역이 없습니다'))
                return self._json(censor_save(p, ops))
            if route == '/api/warm':
                paths = [p for p in body.get('paths', [])[:400] if allowed(p) and is_image(p)]
                size = int(body.get('size', 512))
                if size in THUMB_SIZES:
                    WARMER.request(paths, size)
                return self._json({'ok': True})
            if route == '/api/search':
                root = body['root']
                if not allowed(root):
                    return self._error(403, 'scan first')
                return self._json(search_prompts(root, body.get('q', '')))
            if route == '/api/export':
                folder = body['folder']
                if not allowed(folder) or not os.path.isdir(folder):
                    return self._error(403, 'outside root')
                list_file = body.get('list') or None
                list_root = None
                if list_file:
                    list_root = OPEN_LIST_ROOTS.get(path_pair(list_file))
                    if not list_root or not inside_open_root(path_pair(folder), list_root):
                        return self._error(403, 'scan list first')
                    if not os.path.isfile(list_file):
                        return self._error(404, 'no list file')
                rep, md, paths = write_export(folder, list_file, list_root=list_root)
                EXPORTED_REPORTS.update(path_pair(p) for p in paths.values())
                return self._json({'summary': rep['summary'], 'md': md, 'paths': paths,
                                   'regen': [i['rel'] for i in rep['items'] if i['regen']]})
            if route == '/api/reveal':
                p = body['path']
                if not (allowed(p) or EXPORTED_REPORTS.get(norm(p)) == norm(os.path.realpath(p))) or not os.path.exists(p):
                    return self._error(404, 'no path')
                p = os.path.normpath(p)
                subprocess.Popen(f'explorer /select,"{p}"' if os.path.isfile(p) else f'explorer "{p}"')
                return self._json({'ok': True})
            if route == '/api/pickdir':
                return self._json({'path': pick_directory(body.get('initial', ''))})
            return self._error(404, 'not found')
        except (KeyError, TypeError, ValueError, IndexError) as e:
            return self._error(400, f'bad request: {e}')
        except OSError as e:
            return self._error(500, f'{type(e).__name__}: {e}')


def find_edge():
    for c in (shutil.which('msedge'),
              os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe'),
              os.path.expandvars(r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe')):
        if c and os.path.isfile(c):
            return c
    return None


def open_browser(url):
    edge = find_edge() if CFG.get('app_window', True) else None
    if edge:
        subprocess.Popen([edge, f'--app={url}', '--start-maximized'])
    else:
        webbrowser.open(url)


def already_running(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/ping', timeout=0.5) as r:
            result = json.loads(r.read(4096))
            return isinstance(result, dict) and result.get('app') == 'nai-review-viewer'
    except (OSError, ValueError, http.client.HTTPException):
        return False


class ViewerServer(ThreadingHTTPServer):
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(folder, browser=True, list_file=None):
    url = f'http://127.0.0.1:{PORT}/'
    if list_file:
        url += '?list=' + urllib.parse.quote(os.path.abspath(list_file))
    elif folder:
        url += '?root=' + urllib.parse.quote(os.path.abspath(folder))
    if already_running(PORT):
        print(T('이미 실행 중인 뷰어에 창을 엽니다.'))
        if browser:
            open_browser(url)
        return
    try:
        srv = ViewerServer(('127.0.0.1', PORT), Handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE or getattr(exc, 'winerror', None) == 10048:
            sys.exit(T('포트 {port}를 이미 사용 중입니다. 다른 프로그램을 닫거나 NAI_REVIEW_PORT를 바꾸세요.', port=PORT))
        if exc.errno == errno.EACCES:
            sys.exit(T('포트 {port}를 열 수 없습니다. NAI_REVIEW_PORT에 다른 포트 번호를 지정하세요.', port=PORT))
        raise
    srv.daemon_threads = True
    print(T('NAI 검수 뷰어: {url}', url=url) + '\n' + T('이 창을 닫으면 뷰어가 종료됩니다.'), flush=True)
    if browser:
        open_browser(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def llm_prompt():
    """Claude Code·Codex 등에 붙여 넣는 연결 프롬프트(이 PC의 실제 경로가 들어간다). 본문은 i18n/llm-prompt.<언어>.txt."""
    tpl = (I18N_DIR / f'llm-prompt.{LANG}.txt').read_text(encoding='utf-8')
    # The templates enclose command paths in single quotes for PowerShell.
    return tpl.format(py=sys.executable.replace("'", "''"),
                      script=str(APP_DIR / 'review_viewer.py').replace("'", "''"),
                      doc=APP_DIR / 'LLM-CONNECT.md')


def main():
    global STORE
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) > 1 and sys.argv[1] == 'llm-prompt':
        text = llm_prompt()
        if '--copy' in sys.argv[2:]:
            subprocess.run(['clip'], input=text.encode('utf-16'), check=True)
            print(T('연결 프롬프트를 클립보드에 복사했습니다. Claude Code·Codex 대화창에 붙여 넣으세요.') + '\n')
        print(text)
        return
    STORE = Store(DB_PATH)
    if len(sys.argv) > 1 and sys.argv[1] == 'export':
        ap = argparse.ArgumentParser(prog='review_viewer.py export')
        ap.add_argument('folder', nargs='?', default='')
        ap.add_argument('--list', help='목록 모드: 이 목록(manifest.json·경로 txt)에 든 이미지만')
        ap.add_argument('--print', choices=('md', 'json'), dest='show')
        a = ap.parse_args(sys.argv[2:])
        if not a.folder and not a.list:
            ap.error(T('폴더 또는 --list가 필요합니다'))
        rep, md, paths = write_export(a.folder, a.list)
        if a.show == 'md':
            print(md)
        elif a.show == 'json':
            print(json.dumps(rep, ensure_ascii=False, indent=1))
        else:
            s = rep['summary']
            print(T('불합격 {reject} · 세트 탈락 {set_reject} · 대표 {keeper} · 추가 생산 {more} · 삭제 {deleted} · 안 본 것 {unseen_unmarked} / 전체 {total}', **s))
            print(paths['md'])
            print(paths['json'])
        return
    ap = argparse.ArgumentParser(prog='review_viewer.py')
    ap.add_argument('folder', nargs='?', default='')
    ap.add_argument('--no-browser', action='store_true', help='창을 열지 않고 서버만 띄운다')
    ap.add_argument('--list', help='목록 모드로 연다: manifest.json 또는 경로 txt(nai_autogen.py eyes --open이 만든다)')
    a = ap.parse_args()
    if a.folder and not os.path.isdir(a.folder):
        sys.exit(T('폴더가 없습니다: {path}', path=a.folder))
    if a.list and not os.path.isfile(a.list):
        sys.exit(T('목록 파일이 없습니다: {path}', path=a.list))
    serve(a.folder, not a.no_browser, a.list)


if __name__ == '__main__':
    try:
        if LANG != 'ko':
            _i18n('server.txt')
            _i18n('ui.txt')
        main()
    except (OSError, ValueError) as exc:
        sys.exit(str(exc))
