# 06 · maut-claude-images

## What it does

Previews for the `[Image #N]` references Claude Code prints, on macOS and Windows:

1. **Thumbnail** — a numbered thumbnail drawn right above (or below) each image's first `[Image #N]`, on free cells only (blank or the `────` borders around Claude's prompt). Text is never covered.
2. **Hover** — hovering an `[Image #N]` or its thumbnail shows the image at up to 480 px.
3. **Open** — cmd+click (ctrl+click on Windows) on the reference, or a plain click on the thumbnail, opens the image in an editor tab.
4. **Unsent images** — when a new `[Image #N]` appears at the prompt, Claude has just read the image from the clipboard and holds it only in memory. Maut snapshots the clipboard at that moment, so the preview works before you send. After sending, the stored copy takes over.
5. **Spawn + adopt Maut Claude terminals** — see `dpcs/14-terminal-naming.md`.

All of it works with Claude Code's fullscreen TUI (`"tui": "fullscreen"`), which is a hard requirement.

## Files

```
extensions/maut-claude-images/src/
├── extension.ts               ← terminals + registers the two commands below
└── claudeImageResolver.ts     ← finds the file behind image N of a terminal's session
src/vs/workbench/contrib/terminalContrib/maut/browser/
├── terminal.maut.claudeImages.contribution.ts   ← overlay: hit boxes, thumbnails, hover, click
└── media/claudeImages.css
```

Commands (internal, called by the workbench):
- `_maut.claudeImages.resolve(shellPid, n)` → image path or `undefined`
- `_maut.claudeImages.captureClipboard(shellPid, n)` → snapshot path

## Where Claude Code keeps images (2.1.2xx)

`~/.claude/image-cache` is gone (Claude deletes it). Images reach disk only when the prompt is sent:

- **Pasted:** inline base64 in the session transcript `~/.claude/projects/<project>/<session>.jsonl`. The user message carries `imagePasteIds: [N, …]` in the same order as its image blocks. Decoded copies are cached in the extension's global storage.
- **Uploaded / queued:** the original file in `~/.claude/uploads/<session>/`, listed by an `inlined_image_paths` attachment after the message. These messages have no `imagePasteIds`; N comes from `~/.claude/history.jsonl` (written when the prompt is submitted or queued): the closest earlier unclaimed entry with the same number of images.
- Tool screenshots are also image blocks, but in `isMeta` messages; they are skipped.

The session comes from the terminal: `~/.claude/sessions/<pid>.json` records every running Claude process; we walk its parent chain (`ps` on macOS, `Get-CimInstance Win32_Process` on Windows) up to the terminal's shell pid.

## Why an overlay, not xterm links

In fullscreen TUI Claude turns on any-motion mouse tracking (`?1003`) and repaints constantly (every frame hides/shows the cursor). Every repaint of a link's rows makes xterm drop the link: the hover closes and the mouseup has no link to activate. So Maut draws its own layer inside `.xterm-screen`: hit boxes and thumbnails are DOM elements that stop pointer events from reaching xterm/Claude, and repaints only move them. Hit boxes are keyed by image number + occurrence, so they slide with the text instead of being recreated.

Claude also emits OSC 8 links for `[Image #N]` in some states; the hit box sits on top, so only Maut's handling runs.

## What was tried and reverted

- **Inline image rendering in the terminal** (xterm image addon / iTerm2 escapes) — Claude's TUI repaints overwrite the image cells. Do not retry.
- **`mautImg:` markdown tooltips on an extension link provider** — superseded by the overlay; xterm drops those hovers on repaint.
