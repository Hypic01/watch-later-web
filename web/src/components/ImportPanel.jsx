import React, { useRef, useState } from "react";
import * as api from "../api.js";
import { CopyIcon, ExternalIcon, UploadIcon, CheckIcon } from "./icons.jsx";

export default function ImportPanel({ onImported }) {
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef(null);

  const copySnippet = async () => {
    try {
      const code = await api.fetchSnippet();
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Couldn't load the snippet — refresh and try again.");
    }
  };

  const parsePayload = (text) => {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.videos)) throw new Error("not a collector payload");
    return data;
  };

  const submit = async (text) => {
    setError(null);
    let payload;
    try {
      payload = parsePayload(text);
    } catch {
      setError("That doesn't look like the collector's JSON. Paste exactly what the snippet copied.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.submitImport({ ...payload, source: payload.source || "console" });
      onImported(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    submit(await file.text());
    e.target.value = "";
  };

  return (
    <div className="importer">
      <h2>Import your Watch Later</h2>
      <p>
        YouTube doesn't let any app read your Watch Later directly, so you export it
        yourself — in your own browser, in about a minute. Nothing to install.
      </p>
      <div className="importer__steps">
        <div className="istep">
          <div className="istep__body">
            <b>Open your Watch Later playlist</b>
            <div className="istep__row">
              <a className="btn btn--ghost" href="https://www.youtube.com/playlist?list=WL"
                target="_blank" rel="noreferrer">
                <ExternalIcon size={14} /> youtube.com/playlist?list=WL
              </a>
            </div>
            <p>Make sure you're signed in to YouTube in that tab.</p>
          </div>
        </div>
        <div className="istep">
          <div className="istep__body">
            <b>Open the browser console on that page</b>
            <p>
              Press <code>⌥⌘J</code> (Mac) or <code>Ctrl+Shift+J</code> (Windows).
              If Chrome asks, type <code>allow pasting</code> and press Enter first —
              that's Chrome's own safety check.
            </p>
          </div>
        </div>
        <div className="istep">
          <div className="istep__body">
            <b>Copy the collector and paste it there</b>
            <div className="istep__row">
              <button className="btn btn--primary" onClick={copySnippet}>
                {copied ? <><CheckIcon size={14} /> Copied</> : <><CopyIcon size={14} /> Copy the collector</>}
              </button>
            </div>
            <p>
              Paste it in the console, press Enter, and watch it scroll your playlist by
              itself (a big list takes about a minute). When it finishes, the result is
              on your clipboard.
            </p>
          </div>
        </div>
        <div className="istep">
          <div className="istep__body">
            <b>Paste the result here</b>
            <textarea value={pasted} onChange={(e) => setPasted(e.target.value)}
              placeholder='{"v":1,"source":"console","videos":[…]}'
              aria-label="Paste the collector JSON here" />
            <div className="istep__row">
              <button className="btn btn--primary" disabled={busy || !pasted.trim()}
                onClick={() => submit(pasted)}>
                {busy ? "Importing…" : "Import"}
              </button>
              <span className="importer__file">
                or <label htmlFor="import-file">upload the watch-later.json file<input
                  id="import-file" ref={fileRef} type="file" accept=".json,application/json"
                  onChange={onFile} /></label> if it downloaded one
              </span>
            </div>
            {error && <div className="importer__error" role="alert">{error}</div>}
          </div>
        </div>
      </div>
      <p className="importer__privacy">
        The collector runs only in your browser and only reads your list — no passwords,
        no cookies, nothing sent anywhere until you paste it here. We store the video
        titles and metadata you import, and never touch your YouTube account.
      </p>
    </div>
  );
}
