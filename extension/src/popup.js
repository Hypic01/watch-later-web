import { WLL_GET_STATUS, WLL_SYNC } from "./messages.js";

const statusNode = document.querySelector("[data-status]");
const emailNode = document.querySelector("[data-email]");
const deltaButton = document.querySelector("[data-sync-delta]");
const fullButton = document.querySelector("[data-sync-full]");
const appLink = document.querySelector("[data-open-app]");

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setBusy(busy) {
  deltaButton.disabled = busy;
  fullButton.disabled = busy;
}

function resultText(result) {
  if (!result) return "Ready when you are.";
  if (!result.ok) return result.error || "The last sync did not finish.";
  if (result.skipped) return "The last sync was safely skipped.";
  const added = Number(result.added) || 0;
  return added === 1 ? "1 new video added." : `${added} new videos added.`;
}

async function renderStatus() {
  try {
    const status = await send({ type: WLL_GET_STATUS });
    if (!status.connected) {
      statusNode.textContent = "Connect this extension from Watch Later Librarian.";
      emailNode.textContent = "";
      setBusy(true);
      return;
    }
    emailNode.textContent = status.email || "Connected";
    statusNode.textContent = status.syncing
      ? "Sync is running in the background. You can close this popup."
      : resultText(status.lastResult);
    setBusy(!!status.syncing);
  } catch {
    statusNode.textContent = "The extension could not read its status.";
    setBusy(true);
  }
}

async function start(mode) {
  setBusy(true);
  statusNode.textContent = mode === "full" ? "Opening YouTube for a full sync." : "Finding new videos.";
  try {
    const reply = await send({ type: WLL_SYNC, mode });
    if (reply?.started) {
      statusNode.textContent = mode === "full"
        ? "Full sync started in the background. You can close this popup."
        : "Sync started. You can close this popup.";
    } else if (reply?.error === "NOT_CONNECTED") {
      statusNode.textContent = "Connect this extension from Watch Later Librarian.";
    } else {
      statusNode.textContent = "A sync is already running.";
    }
  } catch {
    statusNode.textContent = "Sync could not start.";
  }
  await renderStatus();
}

deltaButton.addEventListener("click", () => start("delta"));
fullButton.addEventListener("click", () => start("full"));
appLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: appLink.href });
});

renderStatus();
