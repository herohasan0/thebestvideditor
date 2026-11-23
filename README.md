# The Best Video Editor

A video editor that runs entirely in the browser. Your media never leaves your computer: nothing is uploaded, and there is no account.

**Try it:** https://thebestvideditor.theherostores.workers.dev

![The Best Video Editor](docs/Screenshot%202026-11-24%20at%2003.33.12.png)

Built with Claude Code in about a day: I wrote short specs, let the AI build each feature, then reviewed and tested every change before shipping it.

## What it does

- Timeline with a main track, overlay tracks, audio tracks and text
- Razor tool, trim, reorder, undo and redo, markers, snapping
- Zoom, move, rotate and crop clips; opacity for overlays; fade in and out
- Aspect ratios (16:9, 9:16, 1:1 and more) with TikTok, Reels and Shorts guides
- Detach audio, per-clip volume, waveforms
- Export to MP4 up to 4K, the whole project or one clip at a time
- Lossless export: a clip with cuts only is copied without re-encoding
- Large files open in place from disk, with a small preview copy for smooth scrubbing

## Browser support

Built and tested in Chrome. Edge should behave the same. Firefox and Safari are untested and lack some of the features it relies on (opening files in place, saving straight to disk).

## Run it locally

There is no build step. Serve the folder and open it:

```bash
python3 serve.py
```

Then go to http://localhost:5173.

## How it is built

Plain HTML, CSS and one JavaScript module. The only dependency is [Mediabunny](https://mediabunny.dev), vendored in `vendor/`, which reads and writes the media files. Projects are saved in the browser (IndexedDB).

## Deploy

The site is hosted on Cloudflare Workers as static files:

```bash
npx wrangler deploy
```
