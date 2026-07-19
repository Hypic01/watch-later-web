import React from "react";
import { CHROME_STORE_URL } from "../lib.js";
import { CheckIcon, ExternalIcon, SyncIcon } from "./icons.jsx";

export default function ExtensionConnection({
  extension,
  onConnect,
  busy = false,
  surface = "import",
}) {
  if (!extension || extension.checking) return null;

  if (!extension.present) {
    if (surface !== "import" || !extension.isChromium) return null;
    return (
      <section className="extension-card">
        <span className="extension-card__icon"><SyncIcon size={18} /></span>
        <div className="extension-card__copy">
          <strong>Sync in one click with the Chrome extension</strong>
          <p>It reads your Watch Later in the background, then files new saves for you automatically.</p>
        </div>
        <a className="btn btn--primary" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">
          <ExternalIcon size={14} /> Add to Chrome
        </a>
      </section>
    );
  }

  if (extension.mismatch) {
    return (
      <section className="extension-card extension-card--warning" role="status">
        <span className="extension-card__icon"><SyncIcon size={18} /></span>
        <div className="extension-card__copy">
          <strong>This extension is connected to a different account</strong>
          <p>Reconnect it to sync videos into {extension.accountEmail}.</p>
        </div>
        <button className="btn btn--primary" type="button" disabled={busy} onClick={onConnect}>
          {busy ? "Reconnecting…" : "Reconnect"}
        </button>
      </section>
    );
  }

  if (!extension.connected) {
    return (
      <section className="extension-card" role="status">
        <span className="extension-card__icon"><SyncIcon size={18} /></span>
        <div className="extension-card__copy">
          <strong>Connect the extension</strong>
          <p>Connect it to this account so it can import your Watch Later directly.</p>
        </div>
        <button className="btn btn--primary" type="button" disabled={busy} onClick={onConnect}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </section>
    );
  }

  return (
    <section className="extension-card extension-card--connected" role="status">
      <span className="extension-card__icon"><CheckIcon size={18} /></span>
      <div className="extension-card__copy">
        <strong>Chrome extension connected</strong>
        <p>Use Sync at the top of the page whenever you want to check for new videos.</p>
      </div>
    </section>
  );
}
