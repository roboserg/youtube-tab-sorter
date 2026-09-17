const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const watch = (id, windowId, index, duration, extra = {}) => ({
  id, windowId, index, duration, url: `https://www.youtube.com/watch?v=${id}`,
  pinned: false, discarded: false, pendingUrl: undefined, active: false, groupId: -1, ...extra
});

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function createHarness(initialTabs, options = {}) {
  const tabs = initialTabs.map(tab => ({ ...tab }));
  const groups = (options.groups || []).map(group => ({ ...group }));
  const session = { ...(options.session || {}) };
  const local = { ...(options.local || {}) };
  const calls = [], warnings = [], errors = [];
  let clickListener, messageListener, nextGroupId = 100;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function area(name, data) {
    return {
      async get(keys) {
        calls.push([`storage:${name}:get`, clone(keys)]);
        if (options.storageGet) await options.storageGet(name, keys, data, calls);
        const answer = {};
        if (keys == null) return clone(data);
        for (const key of Array.isArray(keys) ? keys : [keys]) if (Object.hasOwn(data, key)) answer[key] = clone(data[key]);
        return answer;
      },
      async set(values) {
        calls.push([`storage:${name}:set`, clone(values)]);
        if (options.storageSet) await options.storageSet(name, values, data, calls);
        Object.assign(data, clone(values));
      },
      async remove(keys) { calls.push([`storage:${name}:remove`, clone(keys)]); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
  }

  const chrome = {
    action: {
      onClicked: { addListener(fn) { clickListener = fn; } },
      async setTitle(value) { calls.push(['title', clone(value)]); },
      async setBadgeText(value) { calls.push(['badge', clone(value)]); },
      async setBadgeBackgroundColor(value) { calls.push(['badgeColor', clone(value)]); }
    },
    runtime: { onMessage: { addListener(fn) { messageListener = fn; } } },
    storage: { session: area('session', session), local: area('local', local) },
    scripting: {
      async executeScript(details) {
        calls.push(['execute', details.target.tabId]);
        if (options.executeScript) return options.executeScript(details, tabs, calls);
        return [{ result: tabs.find(tab => tab.id === details.target.tabId)?.duration ?? null }];
      }
    },
    tabs: {
      async query(query) {
        calls.push(['query', clone(query)]);
        if (options.query) await options.query(query, tabs, calls);
        let found = tabs;
        if (query.windowId !== undefined) found = found.filter(tab => tab.windowId === query.windowId);
        if (query.active !== undefined) found = found.filter(tab => tab.active === query.active);
        if (query.url) found = found.filter(tab => tab.url.startsWith('https://www.youtube.com/watch'));
        return found.slice().sort((a, b) => a.index - b.index).map(clone);
      },
      async get(id) {
        calls.push(['get', id]);
        if (options.get) await options.get(id, tabs, calls);
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error(`No tab ${id}`);
        return clone(tab);
      },
      async update(id, properties) {
        calls.push(['update', id, clone(properties)]);
        if (options.update) await options.update(id, properties, tabs, calls);
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error(`No tab ${id}`);
        if (properties.active) for (const item of tabs.filter(item => item.windowId === tab.windowId)) item.active = false;
        Object.assign(tab, properties);
        return clone(tab);
      },
      async ungroup(id) {
        calls.push(['ungroup', id]);
        if (options.ungroup) await options.ungroup(id, tabs, calls);
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error(`No tab ${id}`);
        tab.groupId = -1;
      },
      async move(id, { index }) {
        calls.push(['move', id, index]);
        if (options.move) await options.move(id, index, tabs, calls);
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error(`No tab ${id}`);
        const ordered = tabs.filter(item => item.windowId === tab.windowId).sort((a, b) => a.index - b.index).filter(item => item.id !== id);
        ordered.splice(Math.min(index, ordered.length), 0, tab);
        ordered.forEach((item, i) => { item.index = i; });
        return clone(tab);
      },
      async group(opts) {
        calls.push(['group', clone(opts)]);
        if (options.group) await options.group(opts, tabs, calls);
        const id = opts.groupId ?? nextGroupId++;
        for (const tabId of opts.tabIds) tabs.find(tab => tab.id === tabId).groupId = id;
        if (!groups.some(group => group.id === id)) groups.push({ id, windowId: opts.createProperties.windowId, title: '', color: 'grey', collapsed: false });
        return id;
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query(query) { calls.push(['groups:query', clone(query)]); return groups.filter(group => group.windowId === query.windowId).map(clone); },
      async update(id, properties) {
        calls.push(['group:update', id, clone(properties)]);
        if (options.groupUpdate) await options.groupUpdate(id, properties, tabs, calls);
        let group = groups.find(item => item.id === id);
        if (!group) { group = { id }; groups.push(group); }
        Object.assign(group, properties);
        return clone(group);
      }
    }
  };
  const context = vm.createContext({ chrome, URL,
    setTimeout(fn, ms) { calls.push(['timer', ms]); Promise.resolve().then(fn); },
    console: { log() {}, warn(...args) { warnings.push(args); }, error(...args) { errors.push(args); } }
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  vm.runInContext('this.api={sortYouTubeTabs,undoLastSort,getState,isWatchTab,pauseAndReadDuration}', context);
  return {
    tabs, groups, session, local, calls, warnings, errors, api: context.api,
    click(tab = {}) { return clickListener(tab); },
    message(message) { return new Promise(resolve => { assert.equal(messageListener(message, {}, resolve), true); }); },
    order(windowId) { return tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index).map(tab => tab.id); }
  };
}

test('sorts all windows stably, snapshots before mutation, and updates feedback', async () => {
  const h = createHarness([
    watch(1, 1, 0, 20, { active: true }), watch(2, 1, 1, 10), watch(3, 1, 2, 10),
    watch(4, 2, 0, 40, { active: true }), watch(5, 2, 1, 5)
  ]);
  await h.api.sortYouTubeTabs();
  assert.deepEqual(h.order(1), [2, 3, 1]);
  assert.deepEqual(h.order(2), [5, 4]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'group').map(c => c[1].tabIds), [[2, 3, 1], [5, 4]]);
  assert.ok(h.calls.findIndex(c => c[0] === 'storage:session:set' && c[1].undoSnapshot) < h.calls.findIndex(c => c[0] === 'move'));
  assert.deepEqual(h.session.undoSnapshot.windows.map(w => w.windowId), [1, 2]);
  assert.match(h.session.status, /^Sorted 5 tab\(s\)/);
  assert.deepEqual(h.calls.filter(c => c[0] === 'badge').at(-1)[1], { text: '5' });
});

test('current scope changes only the requested window', async () => {
  const h = createHarness([watch(1, 1, 0, 30), watch(2, 1, 1, 10), watch(3, 2, 0, 30), watch(4, 2, 1, 10)]);
  await h.api.sortYouTubeTabs({ scope: 'current', windowId: 2 });
  assert.deepEqual(h.order(1), [1, 2]);
  assert.deepEqual(h.order(2), [4, 3]);
  assert.deepEqual(h.local.settings, { scope: 'current', includeUnknown: false });
  assert.deepEqual(h.session.undoSnapshot.windows.map(w => w.windowId), [2]);
});

test('retries unreadable tabs sequentially, puts unknown last, and restores active tab and collapsed groups', async () => {
  const reads = new Map();
  const h = createHarness([
    watch(9, 1, 0, undefined, { active: true, url: 'https://example.com/' }),
    watch(1, 1, 1, null, { discarded: true, groupId: 7 }), watch(2, 1, 2, null), watch(3, 1, 3, 10)
  ], {
    groups: [{ id: 7, windowId: 1, title: 'Old', color: 'blue', collapsed: true }],
    executeScript(details, tabs) {
      const count = (reads.get(details.target.tabId) || 0) + 1;
      reads.set(details.target.tabId, count);
      return [{ result: details.target.tabId === 1 && count >= 3 ? 15 : tabs.find(t => t.id === details.target.tabId)?.duration ?? null }];
    },
    update(id, properties, tabs) {
      if (properties.active) for (const group of h.groups) group.collapsed = false;
    }
  });
  await h.api.sortYouTubeTabs({ includeUnknown: true });
  assert.deepEqual(h.order(1), [3, 1, 2, 9]);
  assert.equal(reads.get(1), 3);
  assert.equal(reads.get(2), 9);
  assert.equal(h.calls.filter(c => c[0] === 'timer').length, 9);
  const firstActivation = h.calls.findIndex(c => c[0] === 'update' && c[1] === 1);
  const firstPostActivationRead = h.calls.findIndex((c, i) => i > firstActivation && c[0] === 'execute' && c[1] === 1);
  const firstPostActivationTimer = h.calls.findIndex((c, i) => i > firstActivation && c[0] === 'timer');
  assert.ok(firstPostActivationRead > firstActivation && firstPostActivationRead < firstPostActivationTimer);
  assert.deepEqual(h.calls.filter(c => c[0] === 'update').map(c => c[1]), [1, 2, 9]);
  assert.ok(h.calls.some(c => c[0] === 'group:update' && c[1] === 7 && c[2].collapsed === true));
  assert.match(h.session.status, /1 unknown duration\(s\) placed last/);
});

test('restores the tab the user selects between two unreadable-tab activations', async () => {
  let userSwitched = false;
  const h = createHarness([
    watch(9, 1, 0, undefined, { active: true, url: 'https://example.com/' }),
    watch(1, 1, 1, null, { discarded: true }),
    watch(2, 1, 2, null, { discarded: true })
  ], {
    executeScript(details, tabs) {
      if (details.target.tabId === 1 && !userSwitched) {
        for (const tab of tabs) tab.active = tab.id === 9;
        userSwitched = true;
      }
      return [{ result: 12 }];
    }
  });
  await h.api.sortYouTubeTabs();
  assert.equal(userSwitched, true);
  assert.deepEqual(h.calls.filter(c => c[0] === 'update').map(c => c[1]), [1, 2, 9]);
  assert.equal(h.tabs.find(tab => tab.id === 9).active, true);
});

test('pauses pinned tabs without moving or grouping them', async () => {
  const h = createHarness([watch(1, 1, 0, 90, { pinned: true, groupId: 7 }), watch(2, 1, 1, 20), watch(3, 1, 2, 10)]);
  await h.api.sortYouTubeTabs();
  assert.ok(h.calls.some(c => c[0] === 'execute' && c[1] === 1));
  assert.deepEqual(h.order(1), [1, 3, 2]);
  assert.equal(h.calls.some(c => ['move', 'ungroup'].includes(c[0]) && c[1] === 1), false);
});

test('suppresses concurrent sorts and releases the lock after failure', async () => {
  const gate = deferred(); let executions = 0;
  const h = createHarness([watch(1, 1, 0, 10)], { async executeScript() { executions++; if (executions === 1) await gate.promise; return [{ result: 10 }]; } });
  const first = h.api.sortYouTubeTabs();
  while (executions === 0) await Promise.resolve();
  await h.api.sortYouTubeTabs();
  assert.equal(executions, 1); gate.resolve(); await first; await h.api.sortYouTubeTabs(); assert.equal(executions, 2);
  const bad = createHarness([watch(2, 1, 0, 10)], { async query(q) { if (q.url) throw new Error('query failed'); } });
  await bad.api.sortYouTubeTabs(); await bad.api.sortYouTubeTabs();
  assert.equal(bad.calls.filter(c => c[0] === 'query' && c[1].url).length, 2);
  assert.equal(bad.calls.filter(c => c[0] === 'badge').at(-1)[1].text, '!');
});

test('waits for each move to settle before starting the next move or grouping', async () => {
  const gate = deferred();
  let moveCount = 0;
  let activeMoves = 0;
  let maxActiveMoves = 0;
  const h = createHarness([watch(1, 1, 0, 30), watch(2, 1, 1, 20), watch(3, 1, 2, 10)], {
    async move() {
      moveCount++;
      activeMoves++;
      maxActiveMoves = Math.max(maxActiveMoves, activeMoves);
      if (moveCount === 1) await gate.promise;
      activeMoves--;
    },
    async group() { assert.equal(activeMoves, 0); }
  });
  const sorting = h.api.sortYouTubeTabs();
  while (moveCount === 0) await Promise.resolve();
  assert.equal(h.calls.filter(c => c[0] === 'move').length, 1);
  assert.equal(h.calls.some(c => c[0] === 'group'), false);
  gate.resolve();
  await sorting;
  assert.equal(maxActiveMoves, 1);
  assert.equal(h.calls.filter(c => c[0] === 'move').length, 3);
  assert.equal(h.calls.filter(c => c[0] === 'group').length, 1);
});

test('isolates per-window grouping failures, reports failure, and retains Undo', async () => {
  const h = createHarness([
    watch(1, 1, 0, 20), watch(2, 1, 1, 10),
    watch(3, 2, 0, 20), watch(4, 2, 1, 10)
  ], {
    async group(opts) {
      if (opts.createProperties?.windowId === 1) throw new Error('group failed');
    }
  });
  await h.api.sortYouTubeTabs();
  assert.ok(h.calls.some(c => c[0] === 'group' && c[1].createProperties.windowId === 2));
  assert.ok(h.errors.some(args => String(args[0]).includes('window 1')));
  assert.equal(h.calls.filter(c => c[0] === 'badge').at(-1)[1].text, '!');
  assert.ok(h.session.undoSnapshot);
  assert.match(h.session.status, /1 operation\(s\) failed/);
});

test('undo restores order and recreates group title, color, and collapsed state', async () => {
  const h = createHarness([
    watch(9, 1, 0, undefined, { pinned: true }), watch(1, 1, 1, 30, { groupId: 7 }),
    watch(2, 1, 2, 10, { groupId: 7 }), watch(8, 1, 3, undefined, { url: 'https://example.com/' })
  ], { groups: [{ id: 7, windowId: 1, title: 'Original', color: 'blue', collapsed: true }] });
  await h.api.sortYouTubeTabs();
  assert.deepEqual(h.order(1), [9, 2, 1, 8]);
  h.groups.splice(0, h.groups.length, ...h.groups.filter(g => g.id !== 7));
  await h.api.undoLastSort();
  assert.deepEqual(h.order(1), [9, 1, 2, 8]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'group').at(-1)[1].tabIds, [1, 2]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'group:update').at(-1)[2], { title: 'Original', color: 'blue', collapsed: true });
  assert.equal(h.session.undoSnapshot, undefined);
  assert.match(h.session.status, /^Restored 3 tab\(s\)/);
});

test('retains the Undo snapshot when part of restoration fails so it can be retried', async () => {
  const snapshot = {
    version: 1,
    windows: [{ windowId: 1, tabs: [watch(1, 1, 0, 10), watch(2, 1, 1, 20)], groups: [] }]
  };
  const h = createHarness([watch(2, 1, 0, 20), watch(1, 1, 1, 10)], {
    session: { undoSnapshot: snapshot },
    async move(id) { if (id === 1) throw new Error('move failed'); }
  });
  await h.api.undoLastSort();
  assert.deepEqual(h.session.undoSnapshot, snapshot);
  assert.equal(h.calls.filter(c => c[0] === 'badge').at(-1)[1].text, '!');
  assert.match(h.session.status, /1 operation\(s\) failed/);
  assert.match(h.session.status, /Undo is available to retry/);
});

test('fresh checks skip closed, navigated, and moved tabs', async () => {
  let changed = false;
  const h = createHarness([watch(1, 1, 0, 30), watch(2, 1, 1, 20), watch(3, 1, 2, 10)], {
    async query(q, tabs, calls) {
      if (!changed && q.windowId === 1 && calls.filter(c => c[0] === 'query').length >= 2) {
        tabs.find(t => t.id === 1).url = 'https://example.com/';
        tabs.find(t => t.id === 2).windowId = 2;
        tabs.splice(tabs.findIndex(t => t.id === 3), 1);
        changed = true;
      }
    }
  });
  await h.api.sortYouTubeTabs();
  assert.equal(h.calls.some(c => c[0] === 'move'), false);

  const undo = createHarness([watch(1, 1, 0, 10), watch(2, 2, 0, 20)], { session: {
    undoSnapshot: { version: 1, windows: [{ windowId: 1, tabs: [watch(1, 1, 0, 10), watch(2, 1, 1, 20)], groups: [] }] }
  }});
  await undo.api.undoLastSort();
  assert.equal(undo.calls.some(c => c[0] === 'move' && c[1] === 2), false);
  assert.match(undo.session.status, /skipped 1 changed or closed tab/);
});

test('does not mutate tabs when the Undo snapshot cannot be saved', async () => {
  const h = createHarness([watch(1, 1, 0, 30), watch(2, 1, 1, 10)], {
    async storageSet(name, values) {
      if (name === 'session' && values.undoSnapshot) throw new Error('storage full');
    }
  });
  await h.api.sortYouTubeTabs();
  assert.deepEqual(h.order(1), [1, 2]);
  assert.equal(h.calls.some(c => ['move', 'ungroup', 'group'].includes(c[0])), false);
  assert.match(h.session.status, /^Sort failed: storage full$/);
});

test('does not report a completed sort as failed when final status persistence fails', async () => {
  const h = createHarness([watch(1, 1, 0, 30), watch(2, 1, 1, 10)], {
    async storageSet(name, values) {
      if (name === 'session' && values.status && !values.undoSnapshot) throw new Error('status write failed');
    }
  });
  await h.api.sortYouTubeTabs();
  assert.deepEqual(h.order(1), [2, 1]);
  assert.match((await h.api.getState()).status, /^Sorted 2 tab\(s\)/);
  assert.equal(h.calls.filter(c => c[0] === 'badge').at(-1)[1].text, '2');
  assert.ok(h.warnings.some(args => String(args[0]).includes('persist status')));
});

test('pending and unknown-excluded tabs preserve the previous Undo snapshot', async () => {
  const previous = { version: 1, windows: [{ windowId: 9, tabs: [], groups: [] }] };
  const h = createHarness([
    watch(1, 1, 0, 10, { pendingUrl: 'https://www.youtube.com/watch?v=new' }),
    watch(2, 1, 1, null)
  ], { session: { undoSnapshot: previous } });
  await h.api.sortYouTubeTabs({ includeUnknown: false });
  assert.deepEqual(h.session.undoSnapshot, previous);
  assert.equal(h.calls.some(c => c[0] === 'move'), false);
});

test('runtime messages expose state and dispatch sort and undo', async () => {
  const h = createHarness([watch(1, 1, 0, 10)], { local: { settings: { scope: 'current', includeUnknown: true } } });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.message({ type: 'getState' }))), {
    busy: false, status: 'Ready to sort your YouTube tabs.', canUndo: false,
    settings: { scope: 'current', includeUnknown: true }
  });
  assert.equal((await h.message({ type: 'sort', settings: { scope: 'current' }, windowId: 1 })).busy, true);
  while ((await h.api.getState()).busy) await Promise.resolve();
  assert.equal((await h.api.getState()).canUndo, true);
  assert.equal((await h.message({ type: 'undo' })).busy, true);
  while ((await h.api.getState()).busy) await Promise.resolve();
  assert.equal((await h.api.getState()).canUndo, false);
});

test('reports the new busy status immediately while sort initialization is gated', async () => {
  const gate = deferred();
  let localReads = 0;
  const h = createHarness([], {
    session: { status: 'Sorted 4 tab(s); skipped 0 (including pinned tabs).' },
    async storageGet(name) {
      if (name === 'local' && ++localReads === 1) await gate.promise;
    }
  });
  const sorting = h.api.sortYouTubeTabs();
  while (localReads === 0) await Promise.resolve();
  const state = await h.api.getState();
  assert.equal(state.busy, true);
  assert.equal(state.status, 'Reading YouTube video durations…');
  gate.resolve();
  await sorting;
});
