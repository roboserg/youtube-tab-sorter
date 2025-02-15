chrome.action.onClicked.addListener(() => {
  console.log("Extension icon clicked. Attempting to sort YouTube tabs.");

  chrome.tabs.query({ url: "*://www.youtube.com/watch*" }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error("Error querying tabs:", chrome.runtime.lastError);
      return;
    }
    if (!tabs || tabs.length === 0) {
      console.log("No YouTube tabs found.");
      return;
    }
    console.log(`Found ${tabs.length} YouTube tab(s).`);

    const promises = tabs.map(tab => {
      return new Promise((resolve) => {
        // First, pause the video if it's playing
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const video = document.querySelector('video');
            if (video && !video.paused) {
              video.pause();
            }
            // Get duration after ensuring video is paused
            const durationElem = document.querySelector('.ytp-time-duration');
            if (!durationElem) return null;
            const durationText = durationElem.innerText;
            const parts = durationText.split(':').map(Number);
            let seconds = 0;
            for (let i = 0; i < parts.length; i++) {
              seconds = seconds * 60 + parts[i];
            }
            return seconds;
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.error(`Error in tab ${tab.id}:`, chrome.runtime.lastError);
            resolve({ tab, duration: null });
          } else if (results && results[0]) {
            console.log(`Tab ${tab.id} duration: ${results[0].result} seconds.`);
            resolve({ tab, duration: results[0].result });
          } else {
            resolve({ tab, duration: null });
          }
        });
      });
    });

    Promise.all(promises).then(results => {
      const validTabs = results.filter(item => item.duration !== null);
      if (validTabs.length === 0) {
        console.log("No valid video durations found. Ensure the YouTube player is fully loaded.");
        return;
      }
      
      // Sort tabs by duration in ascending order.
      validTabs.sort((a, b) => a.duration - b.duration);

      // Group sorted tabs by their window (if they are in multiple windows).
      const tabsByWindow = {};
      validTabs.forEach(item => {
        const win = item.tab.windowId;
        if (!tabsByWindow[win]) {
          tabsByWindow[win] = [];
        }
        tabsByWindow[win].push(item);
      });

      for (const win in tabsByWindow) {
        tabsByWindow[win].forEach((item, index) => {
          chrome.tabs.move(item.tab.id, { index: index, windowId: parseInt(win) }, () => {
            if (chrome.runtime.lastError) {
              console.error(`Error moving tab ${item.tab.id}:`, chrome.runtime.lastError);
            }
          });
        });
      }
      console.log("Tabs have been sorted by video duration.");
    });
  });
});
