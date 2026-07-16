import React, { useState } from "react";
import * as api from "../api.js";
import { LockIcon, ZapIcon } from "./icons.jsx";

// Two independent surfaces under the board (M8): a sort action whenever
// videos are waiting (every plan sorts everything it stores now), and an
// upgrade pitch when a free library is sitting at its cap.
export default function UpgradeBand({ me, waitingCount, atCap, onToast, onJobStarted }) {
  const [busy, setBusy] = useState(false);

  const upgrade = async () => {
    setBusy(true);
    try {
      const { url } = await api.checkoutUrl();
      location.href = url;
    } catch (e) {
      onToast(
        e.status === 404
          ? "Pro isn't open yet, you're early! Everything you have stays free."
          : e.message
      );
      setBusy(false);
    }
  };

  const sortRemaining = async () => {
    setBusy(true);
    try {
      // Hand the started job up so the sorting bar appears immediately —
      // small jobs finish before any poll would ever show one.
      onJobStarted(await api.classifyRemaining());
    } catch (e) {
      onToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {waitingCount > 0 && (
        <div className="upgrade">
          <span className="upgrade__icon"><ZapIcon size={20} /></span>
          <div className="upgrade__text">
            <b>{waitingCount.toLocaleString()} videos are waiting to be sorted</b>
            <p>The librarian files every one of them into your five rows.</p>
          </div>
          <button className="btn btn--primary" disabled={busy} onClick={sortRemaining}>
            <ZapIcon size={15} /> {busy ? "Starting…" : "Sort now"}
          </button>
        </div>
      )}
      {atCap && me.plan !== "pro" && (
        <div className="upgrade">
          <span className="upgrade__icon"><LockIcon size={20} /></span>
          <div className="upgrade__text">
            <b>Your library is at the free limit</b>
            <p>
              Free keeps your newest {Number(me.videoCap).toLocaleString()} videos.
              Pro imports your whole backlog, with unlimited TL;DRs.
            </p>
          </div>
          <button className="btn btn--primary" disabled={busy} onClick={upgrade}>
            <ZapIcon size={15} /> {busy ? "Opening…" : "Upgrade to Pro"}
          </button>
        </div>
      )}
    </>
  );
}
