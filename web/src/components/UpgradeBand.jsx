import React, { useState } from "react";
import * as api from "../api.js";
import { LockIcon, ZapIcon } from "./icons.jsx";

export default function UpgradeBand({ me, lockedCount, onToast, onJobStarted }) {
  const [busy, setBusy] = useState(false);
  const isPro = me.plan === "pro";

  const upgrade = async () => {
    setBusy(true);
    try {
      const { url } = await api.checkoutUrl();
      location.href = url;
    } catch (e) {
      onToast(
        e.status === 404
          ? "Pro isn't open yet, you're early! Your first 100 stay free."
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
    <div className="upgrade">
      <span className="upgrade__icon">{isPro ? <ZapIcon size={20} /> : <LockIcon size={20} />}</span>
      <div className="upgrade__text">
        <b>{lockedCount.toLocaleString()} more videos are waiting</b>
        <p>
          {isPro
            ? "You're on Pro. Sort the rest whenever you're ready."
            : `Your first ${me.freeQuota} were sorted free. Pro sorts your whole backlog, up to ${Number(me.videoCap).toLocaleString()} videos.`}
        </p>
      </div>
      {isPro ? (
        <button className="btn btn--primary" disabled={busy} onClick={sortRemaining}>
          <ZapIcon size={15} /> {busy ? "Starting…" : "Sort the rest"}
        </button>
      ) : (
        <button className="btn btn--primary" disabled={busy} onClick={upgrade}>
          <ZapIcon size={15} /> {busy ? "Opening…" : "Upgrade to Pro"}
        </button>
      )}
    </div>
  );
}
