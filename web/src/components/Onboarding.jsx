import React, { useState } from "react";
import { INTEREST_OPTIONS } from "../lib.js";
import * as api from "../api.js";

export default function Onboarding({ onDone }) {
  const [picked, setPicked] = useState(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const toggle = (t) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });

  const save = async (skip) => {
    setSaving(true);
    try {
      if (!skip) await api.saveTaste({ interests: [...picked], note });
      else await api.saveTaste({ interests: [], note: "" });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboard">
      <h2>What do you use YouTube for?</h2>
      <p>
        30 seconds, totally optional. The librarian uses this to judge what's worth
        <em> your</em> time — and it keeps learning every time you re-file a video.
      </p>
      <div className="onboard__chips" role="group" aria-label="Pick your interests">
        {INTEREST_OPTIONS.map((t) => (
          <button key={t} className={`chip${picked.has(t) ? " chip--active" : ""}`}
            onClick={() => toggle(t)} aria-pressed={picked.has(t)}>
            {t}
          </button>
        ))}
      </div>
      <textarea
        placeholder={'One line in your own words, e.g. "product design grad, learning motion design, saving music for runs"'}
        value={note} maxLength={280} onChange={(e) => setNote(e.target.value)}
        aria-label="Describe what you watch in one line" />
      <div className="onboard__actions">
        <button className="btn btn--primary" disabled={saving} onClick={() => save(false)}>
          {saving ? "Saving…" : "Save and continue"}
        </button>
        <button className="onboard__skip" disabled={saving} onClick={() => save(true)}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
