import React, { useEffect, useRef, useState } from "react";
import VideoCard from "./VideoCard.jsx";
import { SORTS } from "../lib.js";
import { ArrowLeftIcon, SearchIcon } from "./icons.jsx";

const PAGE_SIZE = 60;

export default function CategoryView({ row, videos, chips, onMove, onDismiss, onDone, onBack,
  onOpenDetail, onTldr, onLearn, freePlan, query, onQuery, sort, onSort }) {
  const RowIcon = row.icon;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);

  useEffect(() => { setLimit(PAGE_SIZE); }, [row.key, query]);

  // progressive loading: pull in the next page before the user reaches the bottom
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setLimit((l) => l + PAGE_SIZE);
    }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [videos.length, limit]);

  const shown = videos.slice(0, limit);

  return (
    <section className="catview" style={{ "--row-tint": row.tint }}>
      <header className="catview__header">
        <button className="btn btn--ghost" onClick={onBack}><ArrowLeftIcon size={15} /> Back</button>
        <span className="row__icon"><RowIcon size={16} /></span>
        <h2>{row.label}</h2>
        <span className="row__count">{videos.length.toLocaleString()}</span>
      </header>
      <div className="catview__search">
        <div className="searchbox searchbox--hero">
          <SearchIcon size={16} />
          <input type="search" placeholder={`Search in ${row.label.toLowerCase()}…`} value={query}
            onChange={(e) => onQuery(e.target.value)} aria-label={`Search in ${row.label}`} />
        </div>
      </div>
      {/* The toolbar hugs the grid: filters on the left, sort order on the right. */}
      <div className="catview__toolbar">
        <div className="catview__toolbar-filters">{chips}</div>
        <select className="select sortbox" value={sort} onChange={(e) => onSort(e.target.value)}
          aria-label="Sort videos">
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>
      {videos.length === 0 ? (
        <div className="row__empty">
          {query.trim() ? `no matches for “${query.trim()}” in this row` : `— ${row.empty ?? "nothing here yet"} —`}
        </div>
      ) : (
        <>
          <div className="grid">
            {shown.map((v) => (
              <VideoCard key={v.id} video={v} onMove={onMove} onDismiss={onDismiss} onDone={onDone}
                onOpenDetail={onOpenDetail} onTldr={onTldr} onLearn={onLearn} freePlan={freePlan} />
            ))}
          </div>
          {videos.length > limit && (
            <div ref={sentinelRef} className="grid__sentinel" role="status">
              loading more · {(videos.length - limit).toLocaleString()} remaining
            </div>
          )}
        </>
      )}
    </section>
  );
}
