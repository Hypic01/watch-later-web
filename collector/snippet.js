// Console-snippet entrypoint. Bundled by build-snippet.js into a single IIFE
// served at GET /collector.js. The user pastes it into DevTools on their
// Watch Later page; it collects everything, then copies the JSON payload to
// the clipboard (with a file-download fallback for very large lists).
import { isWatchLaterPage, createCollector, buildPayload } from "./collector.js";

(async () => {
  const log = (msg) => console.log("%c[Watch Later Librarian] " + msg, "color:#2e6e4e;font-weight:bold");

  if (!isWatchLaterPage(location.href)) {
    alert(
      "This isn't your Watch Later page.\n\n" +
        "Open https://www.youtube.com/playlist?list=WL first, then run the snippet again."
    );
    return;
  }

  log("Collecting your Watch Later — the page will scroll by itself. Leave this tab open.");

  const collector = createCollector({
    doc: document,
    win: window,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  const { videos, truncated } = await collector.collectAll({
    onProgress: ({ count }) => log("Collected " + count + " videos…"),
  });

  if (!videos.length) {
    alert("No videos found. Make sure you're signed in and your Watch Later isn't empty.");
    return;
  }

  const payload = buildPayload(videos, "console");
  const json = JSON.stringify(payload);

  let copied = false;
  try {
    await navigator.clipboard.writeText(json);
    copied = true;
  } catch {
    // Clipboard can fail on huge payloads or missing permission; fall back to download.
  }

  if (!copied || json.length > 900000) {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "watch-later.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  log(
    "Done. " + videos.length + " videos collected" +
      (truncated ? " (list truncated — very large playlist)" : "") + "."
  );
  if (copied) {
    log("The JSON is on your clipboard — go back to Watch Later Librarian and paste it.");
    alert("Done! " + videos.length + " videos collected and copied to your clipboard.\n\nGo back to Watch Later Librarian and paste.");
  } else {
    log("Clipboard was unavailable, so it downloaded as watch-later.json — upload that file instead.");
    alert("Done! " + videos.length + " videos collected.\n\nClipboard was unavailable, so a file named watch-later.json was downloaded — upload it in Watch Later Librarian.");
  }
})();
