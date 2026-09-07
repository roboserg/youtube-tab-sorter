let sorting = false;
let liveStatus = "";
const DEFAULT_SETTINGS = { scope: "all", includeUnknown: false };
const RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 400;

function isWatchTab(tab) {
  try {
    const url = new URL(tab.url);
    return url.origin === "https://www.youtube.com" &&
      url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
  } catch {
    return false;
  }
}

// Injected into the page: keep this independent of service-worker globals.
function pauseAndReadDuration(expectedUrl) {
  if (location.href !== expectedUrl) return null;
  for (const video of document.querySelectorAll("video")) {
    if (!video.paused) video.pause();
  }
  const player = document.querySelector("#movie_player");
  const video = player?.querySelector("video");
  if (!video || player.classList.contains("ytp-live") ||
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")) return null;
  const duration = video.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function isSamePage(tab, original) {
  return tab.windowId === original.windowId && tab.url === original.url && !tab.pendingUrl;
}

function isUnchangedTab(tab, original) {
  return isSamePage(tab, original) && !tab.pinned && isWatchTab(tab);
}

function normalizeSettings(settings = {}) {
  return {
    scope: settings.scope === "current" ? "current" : "all",
    includeUnknown: settings.includeUnknown === true
  };
}

async function getState() {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(["undoSnapshot", "status"]),
    chrome.storage.local.get("settings")
  ]);
  return {
    busy: sorting,
    status: liveStatus || session.status || "Ready to sort your YouTube tabs.",
    canUndo: Boolean(session.undoSnapshot),
    settings: normalizeSettings(local.settings || DEFAULT_SETTINGS)
  };
}

async function showStatus(status, badge = "", failed = false) {
  liveStatus = status;
  // Feedback failures must not interrupt tab operations or leave the lock set.
  await Promise.allSettled([
    chrome.action.setTitle({ title: status }),
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color: failed ? "#b45309" : "#b91c1c" })
  ]);
}

async function finishStatus(status, badge, failed = false) {
  await showStatus(status, badge, failed);
  await chrome.storage.session.set({ status });
}

async function readDuration(tab) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: pauseAndReadDuration, args: [tab.url]
    });
    const duration = result?.[0]?.result;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    // Discarded/loading tabs can become readable after activation.
    return null;
  }
}

async function collectDurations(tabs) {
  const results = await Promise.all(tabs.map(async tab => ({
    tab, duration: tab.discarded ? null : await readDuration(tab)
  })));
  const restore = new Map();
  try {
    // Only one unreadable tab is activated at a time, including discarded tabs.
    for (const [position, item] of results.entries()) {
      if (item.duration !== null) continue;
      try {
        const current = await chrome.tabs.get(item.tab.id);
        if (!isSamePage(current, item.tab)) continue;
        const [active] = await chrome.tabs.query({ windowId: current.windowId, active: true });
        if (!restore.has(current.windowId)) {
          const groups = await chrome.tabGroups.query({ windowId: current.windowId });
          restore.set(current.windowId, { originalId: active?.id, lastActivated: null, groups });
        } else {
          const previous = restore.get(current.windowId);
          // Remember a user's new selection before activating the next retry tab.
          if (active && active.id !== previous.lastActivated) previous.originalId = active.id;
        }
        await showStatus(`Loading video ${position + 1} of ${tabs.length}…`, "…");
        await chrome.tabs.update(current.id, { active: true });
        restore.get(current.windowId).lastActivated = current.id;
        for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          const refreshed = await chrome.tabs.get(current.id);
          if (!isSamePage(refreshed, item.tab)) break;
          item.duration = await readDuration(item.tab);
          if (item.duration !== null) break;
        }
      } catch (error) {
        console.warn(`Unable to load tab ${item.tab.id}:`, error);
      }
    }
  } finally {
    for (const [windowId, { originalId, lastActivated, groups }] of restore) {
      if (originalId == null) continue;
      try {
        const [active] = await chrome.tabs.query({ windowId, active: true });
        // Do not override a different tab the user selected during the retry.
        if (active?.id !== lastActivated) continue;
        const original = await chrome.tabs.get(originalId);
        if (original.windowId !== windowId) continue;
        if (originalId !== lastActivated) await chrome.tabs.update(originalId, { active: true });
        for (const group of groups) {
          if (group.collapsed && original.groupId !== group.id) {
            await chrome.tabGroups.update(group.id, { collapsed: true }).catch(console.warn);
          }
        }
      } catch (error) {
        console.warn("Unable to restore the previously active tab:", error);
      }
    }
  }
  return results;
}

async function captureWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const groups = await chrome.tabGroups.query({ windowId });
  return {
    windowId,
    tabs: tabs.map(({ id, windowId, index, pinned, groupId, url, pendingUrl }) =>
      ({ id, windowId, index, pinned, groupId, url, pendingUrl })),
    groups: groups.map(({ id, title, color, collapsed }) => ({ id, title, color, collapsed }))
  };
}

async function sortWindow(windowId, items, stats) {
  const currentTabs = await chrome.tabs.query({ windowId });
  const currentById = new Map(currentTabs.map(tab => [tab.id, tab]));
  const eligible = items.filter(({ tab }) => {
    const current = currentById.get(tab.id);
    return current && isUnchangedTab(current, tab);
  });
  eligible.sort((a, b) => {
    if (a.duration === null && b.duration !== null) return 1;
    if (b.duration === null && a.duration !== null) return -1;
    return (a.duration - b.duration) ||
      currentById.get(a.tab.id).index - currentById.get(b.tab.id).index;
  });
  let index = currentTabs.filter(tab => tab.pinned).length;
  const moved = [];
  for (const item of eligible) {
    try {
      const current = await chrome.tabs.get(item.tab.id);
      if (!isUnchangedTab(current, item.tab)) continue;
      if (current.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await chrome.tabs.ungroup(current.id);
      }
      const result = await chrome.tabs.move(current.id, { index });
      if (isUnchangedTab(result, item.tab)) {
        moved.push(item);
        index++;
      }
    } catch (error) {
      stats.errors++;
      console.warn(`Skipping tab ${item.tab.id}:`, error);
    }
  }
  if (!moved.length) return;
  const remaining = await chrome.tabs.query({ windowId });
  const remainingById = new Map(remaining.map(tab => [tab.id, tab]));
  const grouped = moved.filter(({ tab }) => {
    const current = remainingById.get(tab.id);
    return current && isUnchangedTab(current, tab);
  });
  if (!grouped.length) return;
  const groupId = await chrome.tabs.group({
    tabIds: grouped.map(({ tab }) => tab.id), createProperties: { windowId }
  });
  stats.sorted += grouped.length;
  stats.unknown += grouped.filter(item => item.duration === null).length;
  await chrome.tabGroups.update(groupId, { title: "YT", color: "red" });
}

async function sortYouTubeTabs(options = {}) {
  if (sorting) return;
  sorting = true;
  liveStatus = "Reading YouTube video durations…";
  try {
    const local = await chrome.storage.local.get("settings");
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...local.settings, ...options });
    await chrome.storage.local.set({ settings });
    await showStatus("Reading YouTube video durations…", "…");
    const query = { url: "https://www.youtube.com/watch*" };
    if (settings.scope === "current") {
      if (!Number.isInteger(options.windowId) || options.windowId < 0) {
        throw new Error("The current window is unavailable. Reopen the popup and try again.");
      }
      query.windowId = options.windowId;
    }
    const tabs = (await chrome.tabs.query(query)).filter(tab => isWatchTab(tab) && !tab.pendingUrl);
    const stats = { sorted: 0, unknown: 0, errors: 0 };
    const before = new Map();
    // Activating an unreadable tab can expand its group, so snapshot first.
    for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
      try {
        before.set(windowId, await captureWindow(windowId));
      } catch (error) {
        stats.errors++;
        console.error(`Unable to save window ${windowId} for Undo:`, error);
      }
    }
    const results = await collectDurations(tabs);
    const tabsByWindow = new Map();
    for (const item of results) {
      if (!before.has(item.tab.windowId) || item.tab.pinned ||
          (item.duration === null && !settings.includeUnknown)) continue;
      if (!tabsByWindow.has(item.tab.windowId)) tabsByWindow.set(item.tab.windowId, []);
      tabsByWindow.get(item.tab.windowId).push(item);
    }
    const snapshots = [];
    for (const windowId of tabsByWindow.keys()) {
      try {
        const snapshot = before.get(windowId);
        const present = new Map((await chrome.tabs.query({ windowId })).map(tab => [tab.id, tab]));
        const eligible = tabsByWindow.get(windowId).filter(({ tab }) => {
          const current = present.get(tab.id);
          return current && isUnchangedTab(current, tab);
        });
        if (eligible.length) {
          snapshots.push(snapshot);
          tabsByWindow.set(windowId, eligible);
        } else {
          tabsByWindow.delete(windowId);
        }
      } catch (error) {
        stats.errors++;
        tabsByWindow.delete(windowId);
        console.error(`Unable to save window ${windowId} for Undo:`, error);
      }
    }
    if (snapshots.length) {
      // Save before the first mutation; Undo survives a service-worker restart.
      await chrome.storage.session.set({
        undoSnapshot: { version: 1, windows: snapshots },
        status: "The previous sort was interrupted. Use Undo to restore its tab layout."
      });
      await showStatus("Sorting tabs and creating groups…", "…");
      for (const [windowId, items] of tabsByWindow) {
        try {
          await sortWindow(windowId, items, stats);
        } catch (error) {
          stats.errors++;
          console.error(`Unable to finish sorting window ${windowId}:`, error);
        }
      }
    }
    const skipped = tabs.length - stats.sorted;
    const status = `Sorted ${stats.sorted} tab(s); skipped ${skipped} (including pinned tabs).` +
      (stats.unknown ? ` ${stats.unknown} unknown duration(s) placed last.` : "") +
      (stats.errors ? ` ${stats.errors} operation(s) failed; use Undo or retry.` : "");
    await finishStatus(status, stats.errors ? "!" : String(stats.sorted), stats.errors > 0);
  } catch (error) {
    console.error("Unable to sort YouTube tabs:", error);
    await finishStatus(`Sort failed: ${error.message || error}`, "!", true).catch(console.error);
  } finally {
    sorting = false;
  }
}

async function restoreWindow(snapshot, stats) {
  const current = await chrome.tabs.query({ windowId: snapshot.windowId });
  const byId = new Map(current.map(tab => [tab.id, tab]));
  const originals = snapshot.tabs.filter(tab => !tab.pinned).sort((a, b) => a.index - b.index);
  const survivors = originals.filter(tab => {
    const now = byId.get(tab.id);
    return now && !now.pinned && isSamePage(now, tab);
  });
  stats.skipped += originals.length - survivors.length;
  const detached = [];
  for (const tab of survivors) {
    try {
      const now = await chrome.tabs.get(tab.id);
      if (!isSamePage(now, tab) || now.pinned) { stats.skipped++; continue; }
      if (now.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) await chrome.tabs.ungroup(tab.id);
      detached.push(tab);
    } catch (error) {
      stats.errors++;
      console.warn(`Unable to detach tab ${tab.id} during Undo:`, error);
    }
  }
  let index = current.filter(tab => tab.pinned).length;
  const restored = [];
  for (const tab of detached) {
    try {
      const now = await chrome.tabs.get(tab.id);
      if (!isSamePage(now, tab) || now.pinned) { stats.skipped++; continue; }
      const moved = await chrome.tabs.move(tab.id, { index });
      if (!isSamePage(moved, tab) || moved.pinned) { stats.skipped++; continue; }
      restored.push(tab);
      stats.restored++;
      index++;
    } catch (error) {
      stats.errors++;
      console.warn(`Unable to restore tab ${tab.id}:`, error);
    }
  }
  const existingGroups = await chrome.tabGroups.query({ windowId: snapshot.windowId });
  const existingIds = new Set(existingGroups.map(group => group.id));
  for (const group of snapshot.groups) {
    try {
      const candidates = restored.filter(tab => tab.groupId === group.id);
      const latest = await chrome.tabs.query({ windowId: snapshot.windowId });
      const latestById = new Map(latest.map(tab => [tab.id, tab]));
      const tabIds = candidates.filter(tab => {
        const now = latestById.get(tab.id);
        return now && !now.pinned && isSamePage(now, tab);
      }).map(tab => tab.id);
      if (!tabIds.length) continue;
      const groupId = await chrome.tabs.group(existingIds.has(group.id)
        ? { groupId: group.id, tabIds }
        : { createProperties: { windowId: snapshot.windowId }, tabIds });
      await chrome.tabGroups.update(groupId, {
        title: group.title, color: group.color, collapsed: group.collapsed
      });
    } catch (error) {
      stats.errors++;
      console.warn(`Unable to restore group ${group.id}:`, error);
    }
  }
}

async function undoLastSort() {
  if (sorting) return;
  sorting = true;
  liveStatus = "Restoring the previous tab layout…";
  try {
    const { undoSnapshot } = await chrome.storage.session.get("undoSnapshot");
    if (!undoSnapshot) {
      await finishStatus("There is no sort to undo in this browser session.", "");
      return;
    }
    await showStatus("Restoring the previous tab layout…", "…");
    const stats = { restored: 0, skipped: 0, errors: 0 };
    for (const snapshot of undoSnapshot.windows) {
      try {
        await restoreWindow(snapshot, stats);
      } catch (error) {
        stats.errors++;
        console.warn(`Unable to restore window ${snapshot.windowId}:`, error);
      }
    }
    if (!stats.errors) await chrome.storage.session.remove("undoSnapshot");
    await finishStatus(`Restored ${stats.restored} tab(s); skipped ${stats.skipped} changed or closed tab(s).` +
      (stats.errors ? ` ${stats.errors} operation(s) failed. Undo is available to retry.` : ""),
    stats.errors ? "!" : "↶", stats.errors > 0);
  } catch (error) {
    await finishStatus(`Undo failed: ${error.message || error}`, "!", true).catch(console.error);
  } finally {
    sorting = false;
  }
}

chrome.action.onClicked.addListener(tab => sortYouTubeTabs({ windowId: tab?.windowId }));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["getState", "sort", "undo"].includes(message?.type)) return false;
  (async () => {
    if (message.type === "sort") {
      void sortYouTubeTabs({ ...normalizeSettings(message.settings), windowId: message.windowId });
    } else if (message.type === "undo") {
      void undoLastSort();
    }
    return getState();
  })().then(sendResponse).catch(error => sendResponse({ error: error.message || String(error) }));
  return true;
});
