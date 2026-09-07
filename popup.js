"use strict";

const sortButton = document.querySelector("#sort");
const undoButton = document.querySelector("#undo");
const unknownCheckbox = document.querySelector("#include-unknown");
const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
const statusElement = document.querySelector("#status");

let settingsDirty = false;
let settingsSubmitted = false;
let requestPending = false;
let stateGeneration = 0;
let nextPollId = 0;
let latestPollApplied = 0;
let lastState = { busy: false, canUndo: false };

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusElement.textContent = `Could not complete the request: ${message}`;
  statusElement.classList.add("error");
}

function updateButtons(state = lastState) {
  sortButton.disabled = Boolean(state.busy) || requestPending;
  undoButton.disabled = Boolean(state.busy) || requestPending || !state.canUndo;
  sortButton.textContent = state.busy ? "Working…" : "Sort YouTube tabs";
}

function selectedScope() {
  return scopeInputs.find(input => input.checked)?.value || "current";
}

function applyState(state) {
  if (!state || typeof state !== "object") return;
  lastState = state;
  updateButtons(state);

  if (state.error) {
    showError(state.error);
  } else {
    statusElement.textContent = state.status || (state.busy ? "Working…" : "Ready");
    statusElement.classList.remove("error");
  }

  if (!settingsDirty && !settingsSubmitted && state.settings) {
    const scope = state.settings.scope === "all" ? "all" : "current";
    for (const input of scopeInputs) input.checked = input.value === scope;
    unknownCheckbox.checked = Boolean(state.settings.includeUnknown);
  }
}

async function getState() {
  const generation = stateGeneration;
  const pollId = ++nextPollId;
  try {
    const state = await chrome.runtime.sendMessage({ type: "getState" });
    if (generation !== stateGeneration || pollId < latestPollApplied) return;
    latestPollApplied = pollId;
    applyState(state);
  } catch (error) {
    if (generation !== stateGeneration || pollId < latestPollApplied) return;
    latestPollApplied = pollId;
    showError(error);
    updateButtons();
  }
}

function setPending(pending) {
  requestPending = pending;
  if (pending) {
    sortButton.disabled = true;
    undoButton.disabled = true;
  } else {
    updateButtons();
  }
}

for (const input of [...scopeInputs, unknownCheckbox]) {
  input.addEventListener("change", () => { settingsDirty = true; });
}

sortButton.addEventListener("click", async () => {
  stateGeneration++;
  setPending(true);
  statusElement.textContent = "Starting sort…";
  statusElement.classList.remove("error");
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const settings = {
      scope: selectedScope(),
      includeUnknown: unknownCheckbox.checked
    };
    settingsSubmitted = true;
    const state = await chrome.runtime.sendMessage({
      type: "sort",
      windowId: currentWindow.id,
      settings
    });
    settingsDirty = false;
    requestPending = false;
    applyState(state);
  } catch (error) {
    setPending(false);
    showError(error);
  }
});

undoButton.addEventListener("click", async () => {
  stateGeneration++;
  setPending(true);
  statusElement.textContent = "Undoing…";
  statusElement.classList.remove("error");
  try {
    const state = await chrome.runtime.sendMessage({ type: "undo" });
    requestPending = false;
    applyState(state);
  } catch (error) {
    setPending(false);
    showError(error);
  }
});

getState();
setInterval(getState, 800);
