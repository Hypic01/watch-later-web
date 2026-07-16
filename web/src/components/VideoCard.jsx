import React, { useState } from "react";
import { formatDuration } from "../lib.js";
import { SparklesIcon, XIcon, MoreIcon, CheckIcon, ExternalIcon } from "./icons.jsx";

const CATEGORIES = ["learn", "watch", "music", "entertainment", "outdated"];

export default function VideoCard({ video, onMove, onDismiss, onDone, onOpenDetail }) {
  // hq720 (1280x720) exists for most videos; hqdefault (480x360) always exists
  const [fallback, setFallback] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const thumb = `https://i.ytimg.com/vi/${video.id}/${fallback ? "hqdefault" : "hq720"}.jpg`;
  const ytUrl = `https://www.youtube.com/watch?v=${video.id}`;
  return (
    <article className="card">
      <button className="card__thumbwrap" onClick={() => onOpenDetail?.(video)}
        aria-label={`View details for "${video.title}"`}>
        <img className="card__thumb" src={thumb} alt="" loading="lazy"
          onError={() => { if (!fallback) setFallback(true); }} />
        <div className="card__open"><span>View details</span></div>
        {video.duration_seconds != null && (
          <span className="card__duration">{formatDuration(video.duration_seconds)}</span>
        )}
      </button>
      <div className="card__body">
        <h3 className="card__title" title={video.title}>
          <button onClick={() => onOpenDetail?.(video)}>{video.title}</button>
        </h3>
        <div className="card__channel">{video.channel}</div>
        {video.reasoning && (
          <div className="card__reasoning" title={video.reasoning}>
            <SparklesIcon size={13} />
            <span>{video.reasoning}</span>
          </div>
        )}
        <div className="card__actions">
          <button onClick={() => onDone(video.id)} aria-label={`Mark "${video.title}" as done`}>
            <CheckIcon size={13} /> done
          </button>
          <div className="card__menuwrap">
            <button className="card__kebab" aria-haspopup="menu" aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)} aria-label="More actions">
              <MoreIcon size={14} />
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="card__menu" role="menu">
                  <a href={ytUrl} target="_blank" rel="noreferrer" role="menuitem"
                    onClick={() => setMenuOpen(false)}>
                    <ExternalIcon size={12} /> Open on YouTube
                  </a>
                  {CATEGORIES.filter((c) => c !== video.category).map((c) => (
                    <button key={c} role="menuitem"
                      onClick={() => { setMenuOpen(false); onMove(video.id, c); }}>
                      move to {c}
                    </button>
                  ))}
                  <button role="menuitem" className="menu-danger"
                    onClick={() => { setMenuOpen(false); onDismiss(video.id); }}>
                    <XIcon size={12} /> dismiss
                  </button>
                  <div className="card__menu-hint">
                    <SparklesIcon size={11} /> moves teach the AI your taste
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
