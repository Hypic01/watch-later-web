import React from "react";
import VideoCard from "./VideoCard.jsx";
import { ChevronRightIcon } from "./icons.jsx";

const MAX_ROW_CARDS = 10;

export default function Row({ label, tint, icon: RowIcon, videos, onMove, onDismiss, onDone, onOpen,
  onOpenDetail, onTldr, onLearn, freePlan, emptyLine }) {
  const shown = videos.slice(0, MAX_ROW_CARDS);
  return (
    <section className="row" style={{ "--row-tint": tint }}>
      <header className="row__header">
        <button className="row__title" onClick={onOpen} aria-label={`View all in ${label}`}>
          <span className="row__icon"><RowIcon size={16} /></span>
          <span className="row__name">{label}</span>
          <span className="row__count">{videos.length.toLocaleString()}</span>
          <span className="row__viewall">View all <ChevronRightIcon size={14} /></span>
        </button>
      </header>
      <div className="row__scroll">
        {videos.length === 0 && <div className="row__empty">— {emptyLine ?? "nothing here yet"} —</div>}
        {shown.map((v) => (
          <VideoCard key={v.id} video={v} onMove={onMove} onDismiss={onDismiss} onDone={onDone}
            onOpenDetail={onOpenDetail} onTldr={onTldr} onLearn={onLearn} freePlan={freePlan} />
        ))}
        {videos.length > MAX_ROW_CARDS && (
          <button className="row__more" onClick={onOpen}>
            View all {videos.length.toLocaleString()}
            <ChevronRightIcon size={18} />
          </button>
        )}
      </div>
    </section>
  );
}
