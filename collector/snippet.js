// Console-snippet entrypoint. Bundled by build-snippet.js into a single IIFE
// served at GET /collector.js. The user pastes it into DevTools on their
// Watch Later page; it collects everything, then copies the JSON payload to
// the clipboard (with a file-download fallback for very large lists).
import {
  buildPayload,
  collectInitial,
  createCollector,
  isMateriallyShort,
  isWatchLaterPage,
  readInitialContinuationToken,
  readPlaylistTotal,
} from "./collector.js";
import { createYtcfgRequestTemplate } from "./innertube.js";
import { createContinuationPaginator } from "./pagination.js";

(async () => {
  const log = (msg) => console.log("%c[Laterlist] " + msg, "color:#6695F7;font-weight:bold");

  if (!isWatchLaterPage(location.href)) {
    alert(
      "This isn't your Watch Later page.\n\n" +
        "Open https://www.youtube.com/playlist?list=WL first, then run the snippet again."
    );
    return;
  }

  log("Collecting your Watch Later. Large lists can take several minutes.");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const expectedTotal = readPlaylistTotal(window);
  const initialToken = readInitialContinuationToken(window);
  let videos = collectInitial({ doc: document, win: window });
  let hasStructuralCompletion = false;
  let complete = initialToken === null
    && !isMateriallyShort(videos.length, expectedTotal);

  if (initialToken !== null) {
    try {
      const requestTemplate = await createYtcfgRequestTemplate({
        win: window,
        doc: document,
      });
      const paginator = createContinuationPaginator({
        fetch: (...args) => Reflect.apply(window.fetch, window, args),
        sleep,
      });
      const result = await paginator.paginate({
        initialVideos: videos,
        continuationToken: initialToken,
        requestTemplate,
        onProgress: ({ count, type }) => {
          if (type === "page" || type === "complete") {
            log("Collected " + count + " videos…");
          }
        },
      });
      videos = result.videos;
      complete = result.complete && result.continuationToken === null;
      hasStructuralCompletion = complete;
    } catch {
      log("Direct collection paused. Trying the page fallback.");
      try {
        const collector = createCollector({ doc: document, win: window, sleep });
        const fallback = await collector.collectAll({
          onProgress: ({ count }) => log("Collected " + count + " videos…"),
        });
        const merged = new Map(videos.map((video) => [video.id, video]));
        for (const video of fallback.videos) {
          if (video?.id && !merged.has(video.id)) merged.set(video.id, video);
        }
        videos = Array.from(merged.values());
      } catch {
        // The completeness error below remains the user-facing result.
      }
      complete = Number.isFinite(Number(expectedTotal))
        && videos.length >= Number(expectedTotal);
    }
  }

  if (!complete) {
    alert(
      "We could not read your whole Watch Later list after repeated attempts. " +
        "Nothing was copied. Please try again."
    );
    return;
  }

  let nextPosition = 0;
  videos = videos.map((video) => {
    const position = Number(video?.position);
    if (Number.isFinite(position) && position > 0) {
      nextPosition = Math.max(nextPosition, position);
      return video;
    }
    nextPosition++;
    return { ...video, position: nextPosition };
  });

  if (!videos.length) {
    alert("No available videos found. Make sure you're signed in and your Watch Later isn't empty.");
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

  const unavailable = hasStructuralCompletion
    ? Math.max(0, Number(expectedTotal) - videos.length)
    : 0;
  const unavailableText = unavailable === 1
    ? ". 1 video is private or deleted"
    : unavailable > 1
      ? `. ${unavailable} videos are private or deleted`
      : "";
  log("Done. " + videos.length + " videos collected" + unavailableText + ".");
  if (copied) {
    log("The JSON is on your clipboard. Go back to Laterlist and paste it.");
    alert("Done! " + videos.length + " videos collected and copied to your clipboard.\n\nGo back to Laterlist and paste.");
  } else {
    log("Clipboard was unavailable, so it downloaded as watch-later.json. Upload that file instead.");
    alert("Done! " + videos.length + " videos collected.\n\nClipboard was unavailable, so a file named watch-later.json was downloaded. Upload it in Laterlist.");
  }
})();
