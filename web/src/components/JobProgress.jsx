import React from "react";
import * as api from "../api.js";
import { SyncIcon, XIcon } from "./icons.jsx";

const PHASE_LABELS = {
  opening: "Opening Watch Later",
  collecting: "Collecting videos",
  importing: "Importing videos",
};

function CollectionProgress({ collection }) {
  const count = Number(collection.count) || 0;
  const expectedTotal = Number(collection.expectedTotal) || 0;
  const determinate = collection.phase === "collecting" && expectedTotal > 0;
  const pct = determinate ? Math.min(100, Math.round((count / expectedTotal) * 100)) : 0;
  const numbers = collection.phase === "collecting"
    ? (expectedTotal > 0
      ? `${count.toLocaleString()} / ${expectedTotal.toLocaleString()}`
      : `${count.toLocaleString()} found`)
    : collection.phase === "importing" && count > 0
      ? `${count.toLocaleString()} videos ready`
      : null;

  return (
    <div className="syncband">
      <div className="syncband__row">
        <span className="syncband__label"><SyncIcon size={14} />
          {PHASE_LABELS[collection.phase] || "Syncing videos"}
        </span>
        {numbers ? <span className="syncband__nums">{numbers}</span> : null}
      </div>
      <div className="progress-track progress-track--band" role="progressbar"
        aria-valuenow={determinate ? pct : undefined} aria-valuemin="0" aria-valuemax="100"
        aria-label="Collection progress">
        <div className={`progress-fill${determinate ? "" : " progress-fill--indeterminate"}`}
          style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

export default function JobProgress({ job, collection, onCancelled }) {
  if (collection) return <CollectionProgress collection={collection} />;
  if (!job) return null;
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const waiting = job.state === "awaiting_batch";
  const cancel = async () => {
    try {
      await api.cancelJob(job.id);
    } finally {
      onCancelled();
    }
  };
  return (
    <div className="syncband">
      <div className="syncband__row">
        <span className="syncband__label"><SyncIcon size={14} /> Sorting</span>
        <span className="syncband__nums">
          {job.processed.toLocaleString()} / {job.total.toLocaleString()}
        </span>
        {waiting && (
          <span className="syncband__note">
            Big import: this runs in the background for up to an hour. You can close this tab and come back.
          </span>
        )}
        <div className="topbar__spacer" />
        <button className="btn btn--ghost" onClick={cancel}><XIcon size={14} /> Cancel</button>
      </div>
      <div className="progress-track progress-track--band" role="progressbar"
        aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"
        aria-label="Sorting progress">
        <div className="progress-fill" style={{ width: `${waiting ? 6 : pct}%` }} />
      </div>
    </div>
  );
}
