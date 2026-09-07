const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);

const watch = (id, windowId, index, duration, extra = {}) => ({
  id,
  windowId,
  index,
  duration,
  url: `https://www.youtube.com/watch?v=${id}`,
  pinned: false,
  discarded: false,
  pendingUrl: undefined,
  groupId: -1,
  ...extra
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(initialTabs, hooks = {}) {
  const tabs = initialTabs.map(tab => ({ ...tab }));
  const calls = [];
  const warnings = [];
  const errors = [];
  let listener;
  let nextGroupId = 100;

  function reindex(windowId) {
    tabs.filter(tab => tab.windowId === windowId)
      .sort((a, b) => a.index - b.index)
      .forEach((tab, index) => { tab.index = index; });
  }

  function clone(tab) {
    return tab && { ...tab };
  }

  const chrome = {
    action: {
      onClicked: {
        addListener(fn) { listener = fn; }
      }
    },
    scripting: {
      async executeScript(details) {
        calls.push(['execute:start', details.target.tabId]);
        if (hooks.executeScript) {
          const value = await hooks.executeScript(details, tabs, calls);
          calls.push(['execute:end', details.target.tabId]);
          return value;
        }
        const tab = tabs.find(item => item.id === details.target.tabId);
        calls.push(['execute:end', details.target.tabId]);
        return [{ result: tab?.duration ?? null }];
      }
    },
    tabs: {
      async query(queryInfo) {
        calls.push(['query', { ...queryInfo }]);
        if (hooks.query) await hooks.query(queryInfo, tabs, calls);
        let result = tabs;
        if (queryInfo.windowId !== undefined) {
          result = result.filter(tab => tab.windowId === queryInfo.windowId);
        }
        if (queryInfo.url) {
          result = result.filter(tab => tab.url.startsWith('https://www.youtube.com/watch'));
        }
        return result.slice().sort((a, b) => a.index - b.index).map(clone);
      },
      async get(tabId) {
        calls.push(['get', tabId]);
        if (hooks.get) await hooks.get(tabId, tabs, calls);
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return clone(tab);
      },
      async ungroup(tabId) {
        calls.push(['ungroup', tabId]);
        if (hooks.ungroup) await hooks.ungroup(tabId, tabs, calls);
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        tab.groupId = -1;
      },
      async move(tabId, { index }) {
        calls.push(['move:start', tabId, index]);
        if (hooks.move) await hooks.move(tabId, index, tabs, calls);
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);

        // Only model ungrouped moves; group-boundary behavior needs browser QA.
        assert.equal(tab.groupId, -1);
        const moving = [tab];
        const windowTabs = tabs.filter(item => item.windowId === tab.windowId)
          .sort((a, b) => a.index - b.index);
        const remainder = windowTabs.filter(item => !moving.includes(item));
        remainder.splice(Math.min(index, remainder.length), 0, ...moving);
        remainder.forEach((item, itemIndex) => { item.index = itemIndex; });
        calls.push(['move:end', tabId, index]);
        return clone(tab);
      },
      async group(options) {
        calls.push(['group', [...options.tabIds], { ...options.createProperties }]);
        if (hooks.group) await hooks.group(options, tabs, calls);
        const groupId = nextGroupId++;
        for (const tabId of options.tabIds) {
          const tab = tabs.find(item => item.id === tabId);
          if (!tab) throw new Error(`No tab with id ${tabId}`);
          tab.groupId = groupId;
        }
        return groupId;
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async update(groupId, properties) {
        calls.push(['group:update', groupId, { ...properties }]);
        if (hooks.update) await hooks.update(groupId, properties, tabs, calls);
        return { id: groupId, ...properties };
      }
    }
  };

  vm.runInNewContext(backgroundSource, {
    chrome,
    URL,
    console: {
      log() {},
      warn(...args) { warnings.push(args); },
      error(...args) { errors.push(args); }
    }
  }, { filename: 'background.js' });

  return {
    tabs,
    calls,
    warnings,
    errors,
    click() {
      assert.equal(typeof listener, 'function');
      return listener();
    },
    order(windowId) {
      reindex(windowId);
      return tabs.filter(tab => tab.windowId === windowId)
        .sort((a, b) => a.index - b.index).map(tab => tab.id);
    }
  };
}

test('sorts stably by duration in each window and groups after all moves', async () => {
  const harness = createHarness([
    watch(1, 1, 0, 20),
    watch(2, 1, 1, 10),
    watch(3, 1, 2, 10),
    watch(4, 2, 0, 40),
    watch(5, 2, 1, 5)
  ]);

  await harness.click();

  assert.deepEqual(harness.order(1), [2, 3, 1]);
  assert.deepEqual(harness.order(2), [5, 4]);
  for (const groupCallIndex of harness.calls
    .map((call, index) => call[0] === 'group' ? index : -1).filter(index => index >= 0)) {
    const groupedIds = harness.calls[groupCallIndex][1];
    assert.ok(groupedIds.every(tabId => harness.calls.slice(0, groupCallIndex)
      .some(call => call[0] === 'move:end' && call[1] === tabId)));
    assert.equal(harness.calls.slice(groupCallIndex + 1)
      .some(call => call[0] === 'move:end' && groupedIds.includes(call[1])), false);
  }
  const groups = harness.calls.filter(call => call[0] === 'group');
  assert.deepEqual(groups.map(call => call[1]), [[2, 3, 1], [5, 4]]);
  assert.deepEqual(groups.map(call => call[2]), [{ windowId: 1 }, { windowId: 2 }]);
});

test('pauses pinned tabs but leaves their position and group unchanged', async () => {
  const harness = createHarness([
    watch(1, 1, 0, 90, { pinned: true, groupId: -1 }),
    watch(2, 1, 1, 20),
    watch(3, 1, 2, 10)
  ]);

  await harness.click();

  assert.ok(harness.calls.some(call => call[0] === 'execute:start' && call[1] === 1));
  assert.deepEqual(harness.order(1), [1, 3, 2]);
  assert.equal(harness.calls.some(call => ['move:start', 'ungroup'].includes(call[0]) && call[1] === 1), false);
  assert.equal(harness.calls.find(call => call[0] === 'group')[1].includes(1), false);
});

test('moves sequentially and does not start grouping until every target move settles', async () => {
  let activeMoves = 0;
  let maxActiveMoves = 0;
  const harness = createHarness([
    watch(1, 1, 0, 30), watch(2, 1, 1, 20), watch(3, 1, 2, 10)
  ], {
    async move() {
      activeMoves++;
      maxActiveMoves = Math.max(maxActiveMoves, activeMoves);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeMoves--;
    },
    async group() {
      assert.equal(activeMoves, 0);
    }
  });

  await harness.click();
  assert.equal(maxActiveMoves, 1);
});

test('suppresses concurrent clicks and releases the lock after success and failure', async () => {
  const gate = deferred();
  let executions = 0;
  const harness = createHarness([watch(1, 1, 0, 10)], {
    async executeScript(details, tabs) {
      executions++;
      if (executions === 1) await gate.promise;
      return [{ result: tabs.find(tab => tab.id === details.target.tabId)?.duration ?? null }];
    }
  });

  const first = harness.click();
  await Promise.resolve();
  await harness.click();
  assert.equal(executions, 1);
  gate.resolve();
  await first;
  await harness.click();
  assert.equal(executions, 2);

  const failing = createHarness([watch(2, 1, 0, 10)], {
    async query(queryInfo) {
      if (queryInfo.url) throw new Error('query failed');
    }
  });
  await failing.click();
  await failing.click();
  assert.equal(failing.calls.filter(call => call[0] === 'query' && call[1].url).length, 2);
});

test('isolates API failures and skips tabs closed, navigated, or moved during extraction', async () => {
  let windowTwoGroupAttempts = 0;
  const harness = createHarness([
    watch(1, 1, 0, 30),
    watch(2, 1, 1, 20),
    watch(3, 1, 2, 10),
    watch(4, 2, 0, 15),
    watch(5, 3, 0, 5)
  ], {
    async executeScript(details, tabs) {
      const tab = tabs.find(item => item.id === details.target.tabId);
      if (details.target.tabId === 1) tabs.splice(tabs.indexOf(tab), 1);
      if (details.target.tabId === 2) tab.url = 'https://example.com/';
      if (details.target.tabId === 3) tab.windowId = 9;
      return [{ result: tab?.duration ?? null }];
    },
    async group(options) {
      if (options.createProperties.windowId === 2) {
        windowTwoGroupAttempts++;
        throw new Error('group failed');
      }
    }
  });

  await harness.click();

  assert.equal(harness.calls.some(call => call[0] === 'move:start' && [1, 2, 3].includes(call[1])), false);
  assert.equal(windowTwoGroupAttempts, 1);
  assert.ok(harness.calls.some(call => call[0] === 'group' && call[2].windowId === 3));
  assert.ok(harness.errors.some(args => String(args[0]).includes('window 2')));
});

test('detaches targets before moving and preserves unrelated group membership', async () => {
  const harness = createHarness([
    watch(9, 1, 0, undefined, { url: 'https://example.com/', groupId: 7 }),
    watch(1, 1, 1, 30, { groupId: 7 }),
    watch(2, 1, 2, 10)
  ]);

  await harness.click();

  assert.deepEqual(harness.order(1), [2, 1, 9]);
  const ungroupIndex = harness.calls.findIndex(call => call[0] === 'ungroup' && call[1] === 1);
  const moveIndex = harness.calls.findIndex(call => call[0] === 'move:start' && call[1] === 1);
  assert.ok(ungroupIndex >= 0 && ungroupIndex < moveIndex);
  assert.equal(harness.tabs.find(tab => tab.id === 9).groupId, 7);
});
