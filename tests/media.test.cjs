const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundPath = path.join(__dirname, "..", "background.js");
const backgroundSource = fs.readFileSync(backgroundPath, "utf8");

function loadBackground() {
  const context = {
    URL,
    console,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      action: { onClicked: { addListener() {} } },
      tabs: {},
      scripting: {},
      tabGroups: { TAB_GROUP_ID_NONE: -1 },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__mediaTest = { pauseAndReadDuration, isWatchTab };`,
    context,
    { filename: backgroundPath },
  );
  return { context, ...context.__mediaTest };
}

function installPage(context, {
  href = "https://www.youtube.com/watch?v=abc123",
  duration = 123,
  extraVideos = [],
  playerPresent = true,
  playerClasses = [],
} = {}) {
  const playerVideo = makeVideo(duration, false);
  const videos = [playerVideo, ...extraVideos];
  const player = playerPresent ? {
    classList: { contains: name => playerClasses.includes(name) },
    querySelector: selector => selector === "video" ? playerVideo : null,
  } : null;

  context.location = { href };
  context.document = {
    querySelectorAll: selector => selector === "video" ? videos : [],
    querySelector: selector => selector === "#movie_player" ? player : null,
  };
  return { playerVideo, videos };
}

function makeVideo(duration, paused) {
  return {
    duration,
    paused,
    pauseCalls: 0,
    pause() {
      this.pauseCalls++;
      this.paused = true;
    },
  };
}

test("pauseAndReadDuration returns the finite positive player duration", () => {
  const { context, pauseAndReadDuration } = loadBackground();
  const { playerVideo } = installPage(context, { duration: 367.25 });

  assert.equal(pauseAndReadDuration(context.location.href), 367.25);
  assert.equal(playerVideo.pauseCalls, 1);
});

test("pauseAndReadDuration pauses every playing video", () => {
  const { context, pauseAndReadDuration } = loadBackground();
  const playing = makeVideo(10, false);
  const alreadyPaused = makeVideo(20, true);
  const { playerVideo } = installPage(context, {
    duration: 30,
    extraVideos: [playing, alreadyPaused],
  });

  assert.equal(pauseAndReadDuration(context.location.href), 30);
  assert.equal(playerVideo.pauseCalls, 1);
  assert.equal(playing.pauseCalls, 1);
  assert.equal(alreadyPaused.pauseCalls, 0);
});

test("pauseAndReadDuration pauses page media but returns null without a player", () => {
  const { context, pauseAndReadDuration } = loadBackground();
  const playing = makeVideo(10, false);
  installPage(context, { playerPresent: false, extraVideos: [playing] });

  assert.equal(pauseAndReadDuration(context.location.href), null);
  assert.equal(playing.pauseCalls, 1);
});

for (const duration of [NaN, Infinity, -Infinity, 0, -1]) {
  test(`pauseAndReadDuration rejects invalid duration ${String(duration)}`, () => {
    const { context, pauseAndReadDuration } = loadBackground();
    installPage(context, { duration });

    assert.equal(pauseAndReadDuration(context.location.href), null);
  });
}

for (const adClass of ["ad-showing", "ad-interrupting"]) {
  test(`pauseAndReadDuration rejects media while ${adClass}`, () => {
    const { context, pauseAndReadDuration } = loadBackground();
    const { playerVideo } = installPage(context, {
      duration: 15,
      playerClasses: [adClass],
    });

    assert.equal(pauseAndReadDuration(context.location.href), null);
    assert.equal(playerVideo.pauseCalls, 1);
  });
}

test("pauseAndReadDuration rejects a live or DVR player with a finite duration", () => {
  const { context, pauseAndReadDuration } = loadBackground();
  const { playerVideo } = installPage(context, {
    duration: 3600,
    playerClasses: ["ytp-live"],
  });

  assert.equal(pauseAndReadDuration(context.location.href), null);
  assert.equal(playerVideo.pauseCalls, 1);
});

test("pauseAndReadDuration does not pause after the tab URL changes", () => {
  const { context, pauseAndReadDuration } = loadBackground();
  const { playerVideo } = installPage(context, {
    href: "https://www.youtube.com/watch?v=new-video",
    duration: 42,
  });

  assert.equal(
    pauseAndReadDuration("https://www.youtube.com/watch?v=old-video"),
    null,
  );
  assert.equal(playerVideo.pauseCalls, 0);
});

test("isWatchTab accepts exact HTTPS www.youtube.com watch URLs with a video id", () => {
  const { isWatchTab } = loadBackground();

  assert.equal(isWatchTab({ url: "https://www.youtube.com/watch?v=abc123" }), true);
  assert.equal(
    isWatchTab({ url: "https://www.youtube.com/watch?list=queue&v=abc123&t=30" }),
    true,
  );
});

test("isWatchTab rejects non-watch, non-www, non-HTTPS, and missing-id URLs", () => {
  const { isWatchTab } = loadBackground();
  const rejected = [
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch/extra?v=abc123",
    "https://www.youtube.com/shorts/abc123",
    "http://www.youtube.com/watch?v=abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://youtube.com/watch?v=abc123",
    "https://www.youtube.com.evil.test/watch?v=abc123",
  ];

  for (const url of rejected) assert.equal(isWatchTab({ url }), false, url);
});

test("isWatchTab safely rejects malformed or missing URLs", () => {
  const { isWatchTab } = loadBackground();

  for (const tab of [{ url: "not a URL" }, { url: "://" }, {}, null]) {
    assert.equal(isWatchTab(tab), false);
  }
});
