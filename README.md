# YouTube Tab Sorter

A Chrome extension that helps you organize your YouTube tabs by automatically sorting and grouping them.

## Features

- Sorts tabs by video length (shortest to longest)
- Pauses video elements in loaded YouTube watch tabs when sorting
- Creates a red tab group labeled "YT" for better organization
- Handles multiple Chrome windows independently

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your Chrome toolbar

## Usage

1. Open videos on `https://www.youtube.com/watch?v=...`
2. Click on the extension icon to detect and sort those tabs
3. The extension will:
   - Pause any currently playing videos
   - Sort your YouTube tabs by video duration (shortest first)
   - Group eligible YouTube tabs into a red tab group labeled "YT" in each window
4. You can resume video playback after sorting is complete

Pinned watch tabs are paused but stay pinned and are not grouped. Sorted tabs
are placed immediately after the pinned tabs in their own window. Equal-length
videos keep their relative order.

Live streams, active ads, and tabs without a finite, positive video duration
(including unloaded players) are skipped. Discarded
tabs are left asleep. Retry after the video has loaded or the ad has finished.
Shorts, embeds, and other YouTube pages are outside the current scope. Tabs that
close or navigate during sorting are skipped when detected. Additional clicks
are ignored until the current sort finishes.

## Development checks

With Node.js 18 or newer installed, run:

```sh
node --check background.js
node --test tests/*.test.cjs
```

The regression tests simulate Chrome APIs and player DOM state. To check real
browser behavior, reload the unpacked extension at `chrome://extensions/`, open
videos of different lengths in two windows, include a pinned tab and an existing
tab group, then click the toolbar icon. Confirm playback pauses, each window has
its own sorted red YT group, and pinned tabs stay pinned. Click again to check
repeat sorting; also try an unloaded video and a live stream.
