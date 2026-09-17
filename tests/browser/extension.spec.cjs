const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '..', '..');

function silentWav(seconds) {
  const sampleRate = 8_000;
  const dataLength = Math.ceil(seconds * sampleRate);
  const wav = Buffer.alloc(44 + dataLength, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

const test = base.extend({
  extension: async ({}, use) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-tab-sorter-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    await context.route(/^https:\/\/www\.youtube\.com\/fixture-media\/\d+\.wav(?:\?.*)?$/, async route => {
      const seconds = Number(path.basename(new URL(route.request().url()).pathname, '.wav'));
      await route.fulfill({ contentType: 'audio/wav', body: silentWav(seconds) });
    });

    await context.route(/^https:\/\/www\.youtube\.com\/watch\?.*$/, async route => {
      const url = new URL(route.request().url());
      const id = url.searchParams.get('v');
      const values = {
        short: 12,
        medium: 75,
        long: 240,
        equal: 75,
        retry: 8,
      };
      const duration = values[id];
      const source = Number.isFinite(duration) && id !== 'retry'
        ? `<source src="/fixture-media/${duration}.wav" type="audio/wav">`
        : '';
      const retryScript = id === 'retry'
        ? `<script>
             const attachMediaWhenActive = () => {
               if (document.visibilityState === 'visible' || document.hasFocus()) {
                 document.querySelector('video').src ||= '/fixture-media/${duration}.wav';
               }
             };
             document.addEventListener('visibilitychange', attachMediaWhenActive);
             window.addEventListener('focus', attachMediaWhenActive);
             setInterval(attachMediaWhenActive, 50);
           </script>`
        : '';
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <div id="movie_player"><video>${source}</video></div>
          ${retryScript}
        </body></html>`,
      });
    });

    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/popup.html`);

    const api = async (method, ...args) => controlPage.evaluate(
      async ({ method, args }) => {
        const call = (object, name, values) => new Promise((resolve, reject) => {
          object[name](...values, result => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(result);
          });
        });
        if (method === 'message') {
          return call(chrome.runtime, 'sendMessage', args);
        }
        if (method === 'createWindow') {
          return call(chrome.windows, 'create', [{ url: args[0], focused: args[1] ?? true }]);
        }
        if (method === 'createTab') return call(chrome.tabs, 'create', args);
        if (method === 'removeWindow') return call(chrome.windows, 'remove', args);
        if (method === 'queryTabs') return call(chrome.tabs, 'query', args);
        if (method === 'updateTab') return call(chrome.tabs, 'update', args);
        if (method === 'group') return call(chrome.tabs, 'group', args);
        if (method === 'updateGroup') return call(chrome.tabGroups, 'update', args);
        if (method === 'getGroup') return call(chrome.tabGroups, 'get', args);
        if (method === 'readDuration') {
          const results = await chrome.scripting.executeScript({
            target: { tabId: args[0] },
            func: () => ({ duration: document.querySelector('#movie_player video')?.duration ?? null, href: location.href, body: document.body?.innerHTML.slice(0, 200) }),
          });
          return results[0]?.result;
        }
        if (method === 'setPlaying') {
          const results = await chrome.scripting.executeScript({
            target: { tabId: args[0] },
            func: async () => {
              const video = document.querySelector('#movie_player video');
              video.muted = true;
              await video.play();
              return video.paused;
            },
          });
          return results[0]?.result;
        }
        if (method === 'isPaused') {
          const results = await chrome.scripting.executeScript({
            target: { tabId: args[0] },
            func: () => document.querySelector('#movie_player video')?.paused,
          });
          return results[0]?.result;
        }
        throw new Error(`Unknown method: ${method}`);
      },
      { method, args },
    );

    try {
      await use({ context, api });
    } finally {
      await context.close();
      const tempRoot = path.resolve(os.tmpdir()) + path.sep;
      const resolvedProfile = path.resolve(profile);
      if (!resolvedProfile.startsWith(tempRoot)) throw new Error(`Refusing to remove non-temporary profile: ${resolvedProfile}`);
      await fs.rm(resolvedProfile, { recursive: true, force: true });
    }
  },
});

const youtube = id => `https://www.youtube.com/watch?v=${id}`;

async function createWindow(extension, ids, focused = true) {
  const { api, context } = extension;
  const existingPages = new Set(context.pages());
  const win = await api('createWindow', ['about:blank'], focused);
  let page = context.pages().find(candidate => !existingPages.has(candidate));
  if (!page) page = await context.waitForEvent('page');
  await page.goto(youtube(ids[0]));
  for (const id of ids.slice(1)) {
    const nextPagePromise = context.waitForEvent('page');
    await api('createTab', { windowId: win.id, url: 'about:blank', active: false });
    const nextPage = await nextPagePromise;
    await nextPage.goto(youtube(id));
  }
  await expect.poll(async () =>
    (await api('queryTabs', { windowId: win.id })).filter(tab => tab.url?.startsWith('https://www.youtube.com/')).length,
  ).toBe(ids.length);
  await expect.poll(async () =>
    (await api('queryTabs', { windowId: win.id }))
      .filter(tab => tab.url?.startsWith('https://www.youtube.com/'))
      .every(tab => tab.status === 'complete'),
  ).toBe(true);
  const tabs = await tabsIn(api, win.id);
  for (const tab of tabs.filter(tab => !/[?&]v=(unknown|retry)(?:&|$)/.test(tab.url))) {
    await expect.poll(async () => (await api('readDuration', tab.id)).duration).toBeGreaterThan(0);
  }
  return win.id;
}

async function tabsIn(api, windowId) {
  return (await api('queryTabs', { windowId })).sort((a, b) => a.index - b.index);
}

async function videoIds(api, windowId) {
  return (await tabsIn(api, windowId))
    .filter(tab => tab.url?.startsWith('https://www.youtube.com/watch'))
    .map(tab => new URL(tab.url).searchParams.get('v'));
}

async function send(api, message) {
  const response = await api('message', message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function sort(api, windowId, settings) {
  await send(api, { type: 'sort', windowId, settings });
  await expect.poll(async () => (await send(api, { type: 'getState' })).busy, { timeout: 45_000 }).toBe(false);
}

test('sorts real tabs in every window and creates one red YT group per window', async ({ extension }) => {
  const { api } = extension;
  const first = await createWindow(extension, ['long', 'short', 'medium']);
  const second = await createWindow(extension, ['medium', 'short'], false);
  const playingTab = (await tabsIn(api, first)).find(tab => tab.url.includes('v=long'));
  expect(await api('setPlaying', playingTab.id)).toBe(false);

  await sort(api, first, { scope: 'all', includeUnknown: false });

  expect(await api('isPaused', playingTab.id)).toBe(true);
  expect(await videoIds(api, first)).toEqual(['short', 'medium', 'long']);
  expect(await videoIds(api, second)).toEqual(['short', 'medium']);
  for (const windowId of [first, second]) {
    const tabs = await tabsIn(api, windowId);
    const groupIds = [...new Set(tabs.filter(tab => tab.url?.includes('youtube.com/watch')).map(tab => tab.groupId))];
    expect(groupIds).toHaveLength(1);
    expect(groupIds[0]).toBeGreaterThanOrEqual(0);
    const details = await api('getGroup', groupIds[0]);
    expect(details).toMatchObject({ color: 'red', title: 'YT' });
  }
});

test('preserves pinned tabs and restores original group membership on undo', async ({ extension }) => {
  const { api } = extension;
  const windowId = await createWindow(extension, ['long', 'medium', 'short']);
  const original = await tabsIn(api, windowId);
  const groupedTabIds = [original[1].id, original[2].id];
  await api('updateTab', original[0].id, { pinned: true });
  const oldGroup = await api('group', { tabIds: groupedTabIds, createProperties: { windowId } });
  await api('updateGroup', oldGroup, { title: 'Before', color: 'blue', collapsed: true });

  const before = await tabsIn(api, windowId);
  await sort(api, windowId, { scope: 'current', includeUnknown: false });
  await expect.poll(async () => send(api, { type: 'getState' })).toMatchObject({ canUndo: true });
  expect((await tabsIn(api, windowId))[0].id).toBe(original[0].id);

  await send(api, { type: 'undo' });
  await expect.poll(async () => (await send(api, { type: 'getState' })).busy).toBe(false);
  const restored = await tabsIn(api, windowId);
  expect(restored.map(tab => tab.id)).toEqual(before.map(tab => tab.id));
  const restoredGroupId = restored.find(tab => tab.id === groupedTabIds[0]).groupId;
  expect(restoredGroupId).toBeGreaterThanOrEqual(0);
  expect(restored.find(tab => tab.id === groupedTabIds[1]).groupId).toBe(restoredGroupId);
  expect(await api('getGroup', restoredGroupId)).toMatchObject({ title: 'Before', color: 'blue', collapsed: true });

  await sort(api, windowId, { scope: 'current', includeUnknown: false });
  expect(await videoIds(api, windowId)).toEqual(['long', 'short', 'medium']);
});

test('current-window scope leaves other windows untouched', async ({ extension }) => {
  const { api } = extension;
  const current = await createWindow(extension, ['long', 'short']);
  const other = await createWindow(extension, ['long', 'short'], false);
  const otherBefore = await tabsIn(api, other);

  await sort(api, current, { scope: 'current', includeUnknown: false });

  expect(await videoIds(api, current)).toEqual(['short', 'long']);
  expect((await tabsIn(api, other)).map(tab => ({ id: tab.id, index: tab.index, groupId: tab.groupId })))
    .toEqual(otherBefore.map(tab => ({ id: tab.id, index: tab.index, groupId: tab.groupId })));
});

test('retries unknown duration after activation and puts still-unknown tabs last', async ({ extension }) => {
  const { api } = extension;
  const windowId = await createWindow(extension, ['medium', 'unknown', 'retry', 'short']);
  const tabs = await tabsIn(api, windowId);
  const previouslyActive = tabs.find(tab => tab.url.includes('v=short')).id;
  await api('updateTab', previouslyActive, { active: true });

  await sort(api, windowId, { scope: 'current', includeUnknown: true });

  expect(await videoIds(api, windowId)).toEqual(['retry', 'short', 'medium', 'unknown']);
  expect((await tabsIn(api, windowId)).find(tab => tab.active).id).toBe(previouslyActive);
  const state = await send(api, { type: 'getState' });
  expect(state).toMatchObject({ busy: false, canUndo: true, settings: { scope: 'current', includeUnknown: true } });
  expect(typeof state.status).toBe('string');
});

test('popup loads its controls and reflects extension state', async ({ extension }) => {
  const page = extension.context.pages().find(candidate => candidate.url().startsWith('chrome-extension://'));
  await page.setViewportSize({ width: 340, height: 520 });
  await expect(page.getByRole('heading', { name: 'YouTube Tab Sorter' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sort YouTube tabs' })).toBeEnabled();
  await expect(page.locator('#status')).not.toHaveText('Loading…');
  await fs.mkdir(path.join(extensionPath, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(extensionPath, 'test-results', 'popup.png'), fullPage: true });
});
