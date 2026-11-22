# NAI Review Viewer · NAI 검수 뷰어 · NAI 検品ビューア

[한국어](#한국어) · [English](#english) · [日本語](#日本語)

A local Windows app for reviewing large batches of NovelAI images by eye. Images you look at and leave unmarked pass; you mark only the ones that fail, and the result is exported as Markdown and JSON.

- Works on its own. No LLM app, account or internet connection is needed to use it.
- Korean, English and Japanese UI.
- Optional: one pasted prompt connects it to Claude Code, Codex or a similar agent.

---

## 한국어

수백~수천 장의 NovelAI 이미지를 눈으로 빠르게 검수하는 Windows용 로컬 앱입니다. 체크 없이 본 이미지는 합격이고, 문제 있는 컷에만 사유를 체크합니다. 결과는 Markdown·JSON으로 내보냅니다.

**설치**

1. [Releases](../../releases)에서 `nai-review-viewer-…-win64.zip`을 받습니다.
2. zip 우클릭 → 속성 → 차단 해제 → 압축 풀기.
3. `NAI-Review-Viewer.bat`을 더블클릭합니다. Python 설치는 필요 없습니다.

소스로 받았다면(Code → Download ZIP) `Install.bat`을 한 번 실행한 뒤 `NAI-Review-Viewer.bat`을 실행합니다.

**기능**

- 그리드·세트별·1장 보기, 폴더 트리, 필터, 파일명·프롬프트 검색
- 숫자 키 하나로 불합격 사유 체크, 메모, 여러 장 한꺼번에 처리, 되돌리기
- 검열 덧칠: 블러·모자이크·먹칠을 그 자리에서 칠해 같은 파일에 저장(원본 보관·복원)
- NovelAI 생성 정보 읽기(PNG 텍스트·EXIF·알파 stealth)
- 삭제는 Windows 휴지통으로
- 검수 기록은 이 PC에만 저장되고, 외부로 보내는 것이 없습니다

사용법은 설치 폴더의 **`Guide.html`**, LLM 연결은 가이드 8절과 [`LLM-CONNECT.md`](LLM-CONNECT.md)를 보세요.

## English

A local Windows app for quickly reviewing hundreds or thousands of NovelAI images by eye. Images you see and leave unmarked pass; you mark only the problem images with a reason. Results are exported as Markdown and JSON.

**Install**

1. Download `nai-review-viewer-…-win64.zip` from [Releases](../../releases).
2. Right-click the zip → Properties → Unblock → extract it.
3. Double-click `NAI-Review-Viewer.bat`. You do not need to install Python.

If you downloaded the source (Code → Download ZIP), run `Install.bat` once, then `NAI-Review-Viewer.bat`.

**Features**

- Grid, per-set and single-image views, folder tree, filters, filename and prompt search
- Mark a rejection reason with one number key, add notes, apply marks in bulk, and undo changes
- Censor touch-up: paint blur, mosaic or black fill on the spot and save to the same file (the original is kept and can be restored)
- Reads NovelAI generation info (PNG text, EXIF, alpha stealth)
- Delete goes to the Windows Recycle Bin
- Review records stay on your PC; nothing is sent anywhere

See **`Guide.html`** in the install folder for usage. For connecting an LLM, see section 8 of the guide and [`LLM-CONNECT.md`](LLM-CONNECT.md).

## 日本語

数百〜数千枚の NovelAI 画像をすばやく目視確認できる Windows 用ローカルアプリです。チェックなしで確認した画像は合格で、問題のある画像にだけ理由をチェックします。結果は Markdown・JSON で書き出します。

**インストール**

1. [Releases](../../releases) から `nai-review-viewer-…-win64.zip` をダウンロードします。
2. zip を右クリック → プロパティ → ブロックの解除 → 展開。
3. `NAI-Review-Viewer.bat` をダブルクリックします。Python のインストールは不要です。

ソースで入手した場合(Code → Download ZIP)は、`Install.bat` を一度実行してから `NAI-Review-Viewer.bat` を実行します。

**機能**

- グリッド・セット別・1枚表示、フォルダツリー、フィルター、ファイル名・プロンプト検索
- 数字キーひとつで不合格の理由をチェック、メモ、複数枚の一括操作、元に戻す
- 修正加筆：その場でぼかし・モザイク・黒塗りを加えて上書き保存。元画像は保管され、復元できます
- NovelAI の生成情報の読み取り(PNG テキスト・EXIF・アルファ stealth)
- 削除は Windows のごみ箱へ
- 検品記録はこの PC にのみ保存され、外部には何も送信しません

使い方はインストールフォルダの **`Guide.html`**、LLM 接続はガイドの 8 節と [`LLM-CONNECT.md`](LLM-CONNECT.md) を参照してください。

---

## For developers

- `review_viewer.py` — local server (binds to `127.0.0.1` only) and export CLI. `static/` — UI. `config.json` — reasons, set rule, port, export names. A `config.local.json`, if present, is used instead.
- Source text is Korean. `i18n/ui.txt` and `i18n/server.txt` hold the English and Japanese strings; run `python tools/check_i18n.py` after changing UI text.
- Needs Python 3.10+ with Pillow and numpy, or the private runtime that `Install.bat` builds.
- Release zip: run `Install.bat`, then `runtime\python.exe tools\build_release.py` → `dist\nai-review-viewer-<version>-win64.zip`.

## License

MIT © 불프하르트. The release zip bundles Python, Pillow and numpy under their own licenses; see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Not affiliated with NovelAI.
