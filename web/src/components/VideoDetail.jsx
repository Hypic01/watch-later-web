import React, { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { formatDuration, parseTopics } from "../lib.js";
import {
  ArrowLeftIcon,
  ExternalIcon,
  LearnIcon,
  LockIcon,
  SparklesIcon,
  SummaryIcon,
  XIcon,
  ZapIcon,
} from "./icons.jsx";

const CATEGORIES = ["learn", "watch", "music", "entertainment", "outdated"];
const SUMMARY_BUSY = new Set(["fetching", "summarizing"]);

function transcriptPayload(result) {
  const metadata = result?.metadata || {};
  return {
    transcript: result?.transcript,
    source: result?.source || "extension",
    description: result?.description ?? metadata.description ?? null,
    uploadDate: result?.uploadDate ?? metadata.uploadDate ?? null,
    durationSeconds: result?.durationSeconds ?? metadata.durationSeconds ?? null,
    channel: result?.channel ?? metadata.channel ?? null,
  };
}

export default function VideoDetail({
  video: preview,
  rowMeta,
  me,
  intent = null,
  extensionPresent,
  fetchTranscriptFromExtension,
  onBack,
  onMove,
  onDismiss,
  onToast,
  onSummaryUsed,
  onLearn,
}) {
  const [video, setVideo] = useState(preview);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [fallback, setFallback] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryState, setSummaryState] = useState("idle");
  const [summaryError, setSummaryError] = useState("");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const intentDoneRef = useRef(false);

  useEffect(() => {
    let active = true;
    setVideo(preview);
    setDetailLoading(true);
    setDetailError("");
    setFallback(false);
    setSummary(null);
    setSummaryState("idle");
    setSummaryError("");
    setUpgradeOpen(false);

    api.getVideo(preview.id).then(
      (detail) => {
        if (!active) return;
        setVideo(detail);
        setDetailLoading(false);
      },
      (error) => {
        if (!active) return;
        setDetailError(error.message || "The video details could not load.");
        setDetailLoading(false);
      },
    );
    return () => { active = false; };
  }, [preview.id]);

  useEffect(() => {
    if (!upgradeOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !upgradeBusy) setUpgradeOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [upgradeBusy, upgradeOpen]);

  const summaryUsed = Number(me.summariesUsed) || 0;
  const summaryQuota = Number(me.summaryQuota) || 100;
  const freePlan = me.plan !== "pro" && !me.isAdmin;
  const atSummaryWall = freePlan && summaryUsed >= summaryQuota;
  const transcriptAvailable = Boolean(video.transcript_available);
  const RowIcon = rowMeta?.icon;
  const thumb = `https://i.ytimg.com/vi/${video.id}/${fallback ? "hqdefault" : "maxresdefault"}.jpg`;
  const ytUrl = `https://www.youtube.com/watch?v=${video.id}`;

  const meta = [
    video.channel,
    video.duration_seconds != null && formatDuration(video.duration_seconds),
    video.upload_date && `uploaded ${video.upload_date}`,
  ].filter(Boolean).join(" · ");

  const loadSummary = async () => {
    if (detailLoading || SUMMARY_BUSY.has(summaryState) || summaryState === "done") return;
    setSummaryError("");

    try {
      if (!transcriptAvailable) {
        // This state lands before the first request. A fast transcript fetch can
        // never make the click appear inert.
        setSummaryState("fetching");
        if (extensionPresent && fetchTranscriptFromExtension) {
          const captured = await fetchTranscriptFromExtension(video.id);
          if (!captured?.ok || !captured.transcript) {
            throw new Error(captured?.message || captured?.error || "The extension could not read captions for this video.");
          }
          await api.saveTranscript(video.id, transcriptPayload(captured));
        } else {
          await api.fetchTranscriptFromServer(video.id);
        }
        setVideo((current) => ({ ...current, transcript_available: true }));
      }

      // This state also lands before the summary request, including when the
      // transcript request finishes inside the same click.
      setSummaryState("summarizing");
      const result = await api.summarizeVideo(video.id);
      setSummary(result.summary);
      setSummaryState("done");
      onSummaryUsed?.(result.summariesUsed, result.summaryQuota);
    } catch (error) {
      if (error.status === 402 && error.body?.upgrade) {
        setSummaryState("upgrade");
        return;
      }
      setSummaryError(error.message || "The summary could not be generated.");
      setSummaryState("error");
    }
  };

  const beginUpgrade = async () => {
    setUpgradeBusy(true);
    try {
      const { url } = await api.checkoutUrl();
      location.href = url;
    } catch (error) {
      onToast?.(
        error.status === 404
          ? "Pro is not open yet. You are early, and your monthly TL;DRs keep refilling free."
          : error.message,
      );
      setUpgradeBusy(false);
    }
  };

  const learn = () => {
    if (freePlan) {
      setUpgradeOpen(true);
      return;
    }
    onLearn?.(video);
  };

  // A TL;DR or Learn click on the card carries into this view as an intent:
  // act on it exactly once, as soon as the detail has loaded.
  useEffect(() => {
    intentDoneRef.current = false;
  }, [preview.id]);
  useEffect(() => {
    if (!intent || intentDoneRef.current || detailLoading) return;
    intentDoneRef.current = true;
    if (intent === "tldr") loadSummary();
    if (intent === "learn") learn();
  });

  const move = async (event) => {
    const category = event.target.value;
    event.target.value = "";
    if (!category) return;
    await onMove(video.id, category);
    setVideo((current) => ({ ...current, category }));
  };

  const dismiss = async () => {
    await onDismiss(video.id);
    onBack();
  };

  const summaryButtonLabel = summaryState === "fetching"
    ? "Fetching the transcript…"
    : summaryState === "summarizing"
      ? "Summarizing…"
      : "TL;DR";

  return (
    <section className="detail" style={{ "--row-tint": rowMeta?.tint }}>
      <header className="catview__header">
        <button className="btn btn--ghost" onClick={onBack}>
          <ArrowLeftIcon size={15} /> Back
        </button>
      </header>

      <div className="detail__hero">
        <img className="detail__thumb" src={thumb} alt=""
          onError={() => { if (!fallback) setFallback(true); }} />
      </div>

      <div className="detail__head">
        <h2 className="detail__title">{video.title}</h2>
        {meta ? <div className="detail__meta">{meta}</div> : null}
        <div className="detail__tags">
          {rowMeta && RowIcon ? (
            <span className="pill pill--category"><RowIcon size={12} /> {rowMeta.label}</span>
          ) : null}
          {parseTopics(video).map((topic) => <span key={topic} className="pill pill--topic">{topic}</span>)}
          {video.vault_note_path ? <span className="pill pill--vault">in vault</span> : null}
        </div>
        {video.reasoning ? (
          <div className="detail__reasoning">
            <SparklesIcon size={15} />
            <p>{video.reasoning}</p>
          </div>
        ) : null}
        {video.description ? <p className="detail__description">{video.description}</p> : null}
        {detailError ? <div className="detail__error" role="alert">{detailError}</div> : null}
      </div>

      <div className="detail__actions">
        <button className="btn btn--primary" onClick={learn}>
          {freePlan ? <LockIcon size={14} /> : <LearnIcon size={15} />} Learn
        </button>
        <div className="detail__summary-action">
          <button className="btn btn--ghost" onClick={loadSummary}
            disabled={detailLoading || SUMMARY_BUSY.has(summaryState)}>
            <SummaryIcon size={15} /> {summaryButtonLabel}
          </button>
          {freePlan ? (
            <span className="detail__meter">
              {summaryUsed.toLocaleString()} of {summaryQuota.toLocaleString()} TL;DRs used this month
            </span>
          ) : null}
        </div>
        <a className="btn btn--ghost" href={ytUrl} target="_blank" rel="noreferrer">
          <ExternalIcon size={15} /> YouTube
        </a>
        <div className="topbar__spacer" />
        <select defaultValue="" onChange={move} aria-label="Move to another row" className="select detail__move">
          <option value="">move to…</option>
          {CATEGORIES.filter((category) => category !== video.category).map((category) => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        <button className="btn btn--ghost" onClick={dismiss}><XIcon size={14} /> Dismiss</button>
      </div>

      {summaryError ? <div className="detail__error" role="alert">{summaryError}</div> : null}
      {SUMMARY_BUSY.has(summaryState) ? (
        <div className="summary__thinking" role="status" aria-live="polite">
          <SparklesIcon size={14} /> {summaryButtonLabel}
        </div>
      ) : null}

      {(summaryState === "upgrade"
        || (!detailLoading && atSummaryWall && !summary && !video.summary)) ? (
        <div className="summary__upgrade">
          <span className="upgrade__icon"><ZapIcon size={19} /></span>
          <div>
            <b>Your monthly TL;DRs are used</b>
            <p>They reset on the 1st. Pro is unlimited, across your whole library.</p>
          </div>
          <button className="btn btn--primary" onClick={() => setUpgradeOpen(true)}>Upgrade to Pro</button>
        </div>
      ) : null}

      {summary ? (
        <div className="summary">
          <div className="summary__block">
            <div className="summary__label"><SummaryIcon size={12} /> tl;dr</div>
            <p className="summary__tldr">{summary.tldr}</p>
          </div>
          {summary.points?.length ? (
            <div className="summary__block">
              <div className="summary__label"><SparklesIcon size={12} /> key points</div>
              <ul className="summary__points">
                {summary.points.map((point, index) => <li key={`${index}:${point}`}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          {summary.watchIf ? (
            <div className="summary__block summary__verdict">
              <div className="summary__label"><ExternalIcon size={12} /> watch anyway if</div>
              <p>{summary.watchIf}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {upgradeOpen ? (
        <div className="modal" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !upgradeBusy) setUpgradeOpen(false);
        }}>
          <div className="modal__card" role="dialog" aria-modal="true" aria-labelledby="learn-upgrade-title">
            <button className="modal__close" onClick={() => setUpgradeOpen(false)}
              disabled={upgradeBusy} aria-label="Close"><XIcon size={17} /></button>
            <span className="modal__mark"><LearnIcon size={22} /></span>
            <h2 id="learn-upgrade-title">Learn is a Pro superpower.</h2>
            <p>The librarian teaches you the video so you never have to watch it.</p>
            <button className="btn btn--primary" disabled={upgradeBusy} onClick={beginUpgrade}>
              <ZapIcon size={15} /> {upgradeBusy ? "Opening…" : "Upgrade to Pro"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
