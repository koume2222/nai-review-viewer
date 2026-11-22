# NAI Review Viewer — reference for coding agents

This file is written for an LLM agent (Claude Code, Codex, and similar). The viewer works without any agent; connecting one only lets it read the human's review results and act on them.

A person opens a folder of generated images in the viewer and marks the ones that fail. You read the result through the CLI below. You never need the viewer window, the HTTP server, or the database file.

## PowerShell commands

`PY` is the Python that ships with the viewer (`runtime\python.exe` inside the install folder). If that folder does not exist, use a system Python 3.10+ that has Pillow and numpy. `APP` is `review_viewer.py` in the install folder. Substitute the actual paths. Inside a single-quoted PowerShell path, write an apostrophe twice.

| Purpose | Command |
|---|---|
| Open the viewer on a folder (blocks until the console is closed; run it in the background) | `& 'PY' 'APP' '<image folder>'` |
| Open only specific images (list mode) | `& 'PY' 'APP' --list '<list.txt>'` |
| Read the results of a folder | `& 'PY' 'APP' export '<image folder>' --print json` |
| Read the results of a list | `& 'PY' 'APP' export --list '<list.txt>' --print json` |
| Same, as Markdown | replace `--print json` with `--print md` |

- `export` also writes `<image folder>/_review/review-latest.json` and `.md` (plus timestamped copies). In list mode they go next to the list file. The folder and file names can be changed in `config.json` (`export_dirname`, `export_name`, `export_latest`).
- A list file is UTF-8 text with one absolute image path per line, or a JSON array of paths, or `{"items": [{"file": "<path>"}]}`.
- If the server is already running, the open command only opens another window and returns.
- Output text follows the viewer's language setting (Korean, English or Japanese). Use `items[].verdict`, `items[].tag_ids` and `tag_defs[].kind` for decisions across languages. Keys in `summary.by_tag` are translated labels.

## How to read the verdicts

The viewer records what the person looked at. An image with no mark is a pass only if it was seen.

| `verdict` | Meaning | What to do |
|---|---|---|
| `reject` (`regen: true`) | At least one negative reason is marked | Regenerate. Use `tag_ids`, `note` and the hint in `tag_defs` to decide whether to re-roll the seed or edit the prompt |
| `set_reject` | Unmarked image in a set where another image got the ★ pick | Not adopted. Do not regenerate |
| `keeper` | The ★ pick of its set | Adopt this one |
| `more` (`more: true`) | Pass, and the person wants more images like it | Adopt, and generate further variants based on it |
| `pass` | Passed, with a note | Adopt; read the note |
| not in `items` | Seen with no mark (counted in `summary.pass_unmarked`), or unseen | Seen = pass. Unseen = no verdict yet |

- `unseen[]` lists unseen images with no verdict. An unseen, unmarked sibling of a ★ pick already has a `set_reject` verdict in `items[]`. Do not treat them as passed; ask the person to finish, or to use "Pass all".
- `deleted[]` lists files the person sent to the Recycle Bin, with the marks they had.
- `censor_edited[]` lists files the person fixed in the viewer by painting censoring over them. The touch-up clears the censor mark. Check the current verdict in `items[]` for any remaining reasons to regenerate. `backup` is the path of the untouched original.
- `summary.stale` counts images whose file changed after they were marked (for example, overwritten by a regeneration). Their old marks are ignored and they count as unseen again.
- A **set** is the group of images in one folder whose names are equal after removing a trailing variant number (`_2`, `_3`, `_round_01_2`; `_01` with a leading zero is not a variant number). The rule is `set_suffix_regex` in `config.json`.

## JSON fields

```
tool, format, lang, exported_at, folder, list
rules            plain-language restatement of the verdict rules
tag_defs[]       id, kind (positive | keeper | negative), label, llm_hint
summary          total, seen, pass_unmarked, unseen_unmarked, reject, set_reject, keeper, more,
                 stale, deleted, censor_edited, by_tag
items[]          rel, path, set, verdict, regen, more, tags (labels), tag_ids, note, seen, updated,
                 nai {seed, prompt, uc, char_captions, char_uc}   (only for reject / more / keeper; null if no NAI metadata, individual fields optional)
sets[]           set, size, keeper[], reject[], set_reject[], more[]
deleted[]        rel, tags, tag_ids, note, deleted_at
censor_edited[]  rel, edits, last_at, backup
unseen[]         relative path strings
```

`nai` is the NovelAI generation metadata read from the image (PNG text chunk, EXIF, or the alpha-channel stealth data).

## Default reasons

`tag_defs[].llm_hint` carries the fix-it guidance for each reason and is the source of truth, because the person can edit reasons in `config.json`. The defaults:

| `id` | Key | Meaning |
|---|---|---|
| `more` | Q | Good; make more like this |
| `keeper` | W | Only this one of the set passes |
| `anatomy` | 1 | Wrong anatomy |
| `extra_part` | 2 | Extra body parts |
| `extra_person` | 3 | Unwanted extra people |
| `composition` | 4 | Not the intended composition or scene |
| `quality` | 5 | Low quality |
| `messy` | 6 | Cluttered or messy |
| `rethink` | 7 | Needs a different concept; confirm the direction with the person before redoing it |
| `other` | 8 | Other; the reason is in `note` |
| `censor` | 9 | Weak censoring |

## Ground rules

- The review database (`data/review.db`) is keyed by absolute path and file modification time. Moving or renaming a reviewed file outside the viewer loses its marks, and overwriting it makes it unseen again. Tell the person before doing either.
- Do not delete or overwrite image files unless the person asked for it.
- Do not edit `data/` by hand.

## Python API (optional)

When the agent's own script runs under a Python that can import `review_viewer`, `review_viewer.lookup(paths)` returns the current state per path without writing anything:
`{path: {exists, tags, note, seen, stale, deleted, censor_edits}}`.
