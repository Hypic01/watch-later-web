import React, { useEffect, useState } from "react";
import * as api from "../api.js";
import { CheckIcon, HistoryIcon, XIcon } from "./icons.jsx";

export default function CleanupChecklist() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getCleanup().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <div className="loading">loading…</div>;
  return (
    <div className="history">
      <p className="history__hint">
        <HistoryIcon size={15} />
        Everything here is dealt with, safe to remove from your real Watch Later on YouTube.
        One-click bulk removal is coming with the browser extension.
      </p>
      <table>
        <thead>
          <tr><th>Status</th><th>Title</th><th>Channel</th></tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id}>
              <td>
                {v.status === "done"
                  ? <span className="pill pill--done"><CheckIcon size={12} /> done</span>
                  : <span className="pill pill--dismissed"><XIcon size={12} /> dismissed</span>}
              </td>
              <td><a href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank"
                rel="noreferrer">{v.title}</a></td>
              <td>{v.channel}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan="3">nothing dealt with yet. Mark videos done or dismiss them from the board</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
