const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(value = "") {
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = {};
    this.classList = {
      values: new Set(),
      add: value => this.classList.values.add(value),
      remove: value => this.classList.values.delete(value),
      contains: value => this.classList.values.has(value)
    };
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  dispatch(type) { return this.listeners[type](); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeHarness(sendMessage) {
  const sort = new Element();
  const undo = new Element();
  const unknown = new Element();
  const current = new Element("current");
  const all = new Element("all");
  current.checked = true;
  const status = new Element();
  const intervals = [];
  const bySelector = {
    "#sort": sort,
    "#undo": undo,
    "#include-unknown": unknown,
    "#status": status
  };
  const context = {
    chrome: {
      runtime: { sendMessage },
      windows: { getCurrent: async () => ({ id: 42 }) }
    },
    document: {
      querySelector: selector => bySelector[selector],
      querySelectorAll: selector => selector === 'input[name="scope"]' ? [current, all] : []
    },
    setInterval: callback => { intervals.push(callback); },
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "popup.js" });
  return { sort, undo, unknown, current, all, status, intervals };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("shows errors returned by the background and leaves available actions enabled", async () => {
  const ui = makeHarness(async () => ({ error: "Nothing to sort", busy: false, canUndo: true }));
  await tick();
  assert.match(ui.status.textContent, /Nothing to sort/);
  assert.equal(ui.status.classList.contains("error"), true);
  assert.equal(ui.sort.disabled, false);
  assert.equal(ui.undo.disabled, false);
});

test("submitted settings remain authoritative when a reply contains stale settings", async () => {
  const messages = [];
  const ui = makeHarness(async message => {
    messages.push(message);
    if (message.type === "getState") {
      return { busy: false, canUndo: false, settings: { scope: "current", includeUnknown: false } };
    }
    return {
      busy: true,
      canUndo: false,
      status: "Sorting…",
      settings: { scope: "current", includeUnknown: false }
    };
  });
  await tick();
  ui.current.checked = false;
  ui.all.checked = true;
  ui.unknown.checked = true;
  ui.all.dispatch("change");
  await ui.sort.dispatch("click");
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "sort",
    windowId: 42,
    settings: { scope: "all", includeUnknown: true }
  });
  assert.equal(ui.all.checked, true);
  assert.equal(ui.unknown.checked, true);
});

test("an old poll cannot replace a newer operation response", async () => {
  const oldPoll = deferred();
  let getCount = 0;
  const ui = makeHarness(message => {
    if (message.type === "getState" && getCount++ === 0) {
      return Promise.resolve({ busy: false, canUndo: true, status: "Ready" });
    }
    if (message.type === "getState") return oldPoll.promise;
    return Promise.resolve({ busy: true, canUndo: false, status: "Sorting new request…" });
  });
  await tick();
  ui.intervals[0]();
  await ui.sort.dispatch("click");
  oldPoll.resolve({ busy: false, canUndo: true, status: "Stale status" });
  await tick();
  assert.equal(ui.status.textContent, "Sorting new request…");
  assert.equal(ui.sort.disabled, true);
});

test("a rejected action re-enables controls using the last known state", async () => {
  const ui = makeHarness(message => message.type === "getState"
    ? Promise.resolve({ busy: false, canUndo: true, status: "Ready" })
    : Promise.reject(new Error("Disconnected")));
  await tick();
  await ui.sort.dispatch("click");
  assert.match(ui.status.textContent, /Disconnected/);
  assert.equal(ui.sort.disabled, false);
  assert.equal(ui.undo.disabled, false);
});
