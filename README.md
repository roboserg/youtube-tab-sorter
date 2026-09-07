# YouTube Tab Sorter

A Chrome extension that pauses YouTube videos, sorts watch tabs from shortest to
longest, and places them in a red **YT** group in each selected window.

## Installation

Requires Chrome 110 or newer.

1. Download or clone this repository.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Pin the extension to the toolbar if desired.

After updating the files, click **Reload** for the extension on that page.

## Usage

1. Open videos at `https://www.youtube.com/watch?v=...`.
2. Click the extension icon and choose **Current window** or **All windows**.
3. Optionally select **Put unknown durations at the end**.
4. Click **Sort YouTube tabs**. The popup and toolbar tooltip show progress and
   the final sorted/skipped counts. A `!` badge means an operation failed.
5. Use **Undo** to restore the layout from the last sort.

The extension pauses video elements while reading their duration. If the duration
cannot be read, it activates that tab and retries eight times, about 400 ms apart.
This also wakes discarded tabs. Retries run one tab at a time and do not focus
other browser windows. The previously active tab in each affected window is
restored afterward, unless a different tab was selected during the last retry.
Activation can close the toolbar popup; sorting continues and its result is
available when you reopen it.

Pinned watch tabs are paused but remain pinned and are not grouped. Sorted tabs
are placed immediately after the pinned tabs. Equal-length videos retain their
relative order. Live streams, ads, and players without valid metadata are treated
as unknown durations after retrying: they are skipped by default, or placed last
in their original relative order when the option is enabled. The chosen scope and
unknown-duration option are remembered.

Shorts, embeds, and other YouTube pages are outside the current scope. Tabs that
close, navigate, or move to another window during sorting are skipped when
those changes are detected. Sort and Undo cannot run at the same time.

## Undo

Undo saves one layout for the windows affected by the most recent sort. It restores
surviving tabs' relative order, group membership, and group names, colors, and
collapsed states. An emptied group is recreated if needed. The snapshot survives
extension service-worker restarts, but is cleared when the extension is reloaded
or the browser session ends. A sort with no eligible tabs keeps the previous Undo.

Tabs closed, moved between windows, navigated, or repinned since the snapshot are
left alone where possible. Newly opened tabs are not closed; restoring the old
layout can move them after the original tabs. Undo does not resume playback or
put awakened tabs back to sleep. If an operation fails, Undo remains available
for another attempt.

## Development checks

Requires Node.js 22 or newer for the development toolchain.

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Unit tests exercise the service worker and injected media-reading function with
mocked Chrome APIs and player DOM state. Browser tests load the unpacked extension
in an isolated Chromium profile and use the real extension APIs with controlled
YouTube-shaped video pages. They do not use your normal browser profile or account.
GitHub Actions runs both suites on every push and pull request.

For a live YouTube check, reload the extension, open videos of different lengths
in two windows, and include a pinned video and a collapsed group. Check both scope
options, an unloaded video, a live stream, repeated sorting, and Undo. Confirm the
originally active tabs return after retries and that the status reports the result.
YouTube may change its player markup independently of these controlled fixtures.
