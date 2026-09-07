let sorting = false;

function isWatchTab(tab) {
  try {
    const url = new URL(tab.url);
    return url.origin === "https://www.youtube.com" &&
      url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
  } catch {
    return false;
  }
}

// This function runs in the page, so it cannot use service-worker globals.
function pauseAndReadDuration(expectedUrl) {
  if (location.href !== expectedUrl) return null;
  for (const video of document.querySelectorAll("video")) {
    if (!video.paused) video.pause();
  }
  const player = document.querySelector("#movie_player");
  const video = player?.querySelector("video");
  // Ads describe a different video; live/DVR durations can keep growing.
  if (!video || player.classList.contains("ytp-live") ||
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")) return null;
  const duration = video.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function isUnchangedTab(tab, original) {
  return tab.windowId === original.windowId && tab.url === original.url &&
    !tab.pendingUrl && !tab.pinned && !tab.discarded && isWatchTab(tab);
}

async function sortWindow(windowId, items) {
  const currentTabs = await chrome.tabs.query({ windowId });
  const currentById = new Map(currentTabs.map(tab => [tab.id, tab]));
  const eligible = items.filter(({ tab }) => {
    const current = currentById.get(tab.id);
    return current && isUnchangedTab(current, tab);
  });
  eligible.sort((a, b) => a.duration - b.duration ||
    currentById.get(a.tab.id).index - currentById.get(b.tab.id).index);

  let index = currentTabs.filter(tab => tab.pinned).length;
  const moved = [];
  for (const item of eligible) {
    try {
      const current = await chrome.tabs.get(item.tab.id);
      if (!isUnchangedTab(current, item.tab)) continue;
      // Detach first to keep placement independent of existing group boundaries.
      if (current.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await chrome.tabs.ungroup(current.id);
      }
      // Omitting windowId prevents pulling a tab back from another window.
      const result = await chrome.tabs.move(current.id, { index });
      if (result.windowId === windowId && !result.pinned) {
        moved.push(item);
        index++;
      }
    } catch (error) {
      console.warn(`Skipping tab ${item.tab.id}:`, error);
    }
  }

  if (!moved.length) return;
  // Tabs may close, navigate, or change windows while others are processed.
  const remaining = await chrome.tabs.query({ windowId });
  const remainingById = new Map(remaining.map(tab => [tab.id, tab]));
  const tabIds = moved.filter(({ tab }) => {
    const current = remainingById.get(tab.id);
    return current && isUnchangedTab(current, tab);
  }).map(({ tab }) => tab.id);
  if (!tabIds.length) return;
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: "YT", color: "red" });
}

async function sortYouTubeTabs() {
  if (sorting) return;
  sorting = true;
  try {
    const tabs = (await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }))
      .filter(tab => isWatchTab(tab) && !tab.pendingUrl && !tab.discarded);
    const results = await Promise.all(tabs.map(async tab => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: pauseAndReadDuration,
          args: [tab.url]
        });
        const duration = results?.[0]?.result;
        return Number.isFinite(duration) && duration > 0 ? { tab, duration } : null;
      } catch (error) {
        console.warn(`Unable to read tab ${tab.id}:`, error);
        return null;
      }
    }));
    const tabsByWindow = new Map();
    for (const item of results) {
      if (!item || item.tab.pinned) continue;
      if (!tabsByWindow.has(item.tab.windowId)) tabsByWindow.set(item.tab.windowId, []);
      tabsByWindow.get(item.tab.windowId).push(item);
    }
    for (const [windowId, items] of tabsByWindow) {
      try {
        await sortWindow(windowId, items);
      } catch (error) {
        console.error(`Unable to finish sorting window ${windowId}:`, error);
      }
    }
  } catch (error) {
    console.error("Unable to sort YouTube tabs:", error);
  } finally {
    sorting = false;
  }
}

chrome.action.onClicked.addListener(sortYouTubeTabs);
