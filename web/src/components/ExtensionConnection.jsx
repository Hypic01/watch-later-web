import React from "react";
import { CheckIcon, SyncIcon } from "./icons.jsx";

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
          <strong>Get the Chrome extension for one click sync</strong>
          <p>Chrome Web Store access is coming soon. The browser collector below works now.</p>
        </div>
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
