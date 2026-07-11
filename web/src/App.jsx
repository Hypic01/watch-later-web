import React, { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.js";
import { SORTS, parseTopics } from "./lib.js";
import { hasSession, signInWithGoogle, signInDev, isDevAuth, onAuthChange } from "./auth.js";
import Row from "./components/Row.jsx";
import CategoryView from "./components/CategoryView.jsx";
import CleanupChecklist from "./components/CleanupChecklist.jsx";
import Onboarding from "./components/Onboarding.jsx";
import ImportPanel from "./components/ImportPanel.jsx";
import JobProgress from "./components/JobProgress.jsx";
import UpgradeBand from "./components/UpgradeBand.jsx";
import Settings from "./components/Settings.jsx";
import {
  LearnIcon, EyeIcon, MusicIcon, GamepadIcon, ArchiveIcon, BoardIcon,
  HistoryIcon, SettingsIcon, UploadIcon, GoogleIcon,
} from "./components/icons.jsx";

const ROWS = [
  { key: "learn", label: "Worth learning from", tint: "var(--cat-learn)", icon: LearnIcon,
    empty: "no lessons pending" },
  { key: "watch", label: "Worth watching", tint: "var(--cat-watch)", icon: EyeIcon,
    empty: "your eyes are off the hook" },
  { key: "music", label: "Music", tint: "var(--cat-music)", icon: MusicIcon,
    empty: "all quiet in here" },
  { key: "entertainment", label: "Just for fun", tint: "var(--cat-entertainment)", icon: GamepadIcon,
    empty: "no fun pending" },
  { key: "outdated", label: "Outdated", tint: "var(--cat-outdated)", icon: ArchiveIcon,
    empty: "nothing has aged out yet" },
];

const DURATIONS = [
  { key: "xs", label: "< 5 min", test: (d) => d != null && d < 300 },
  { key: "md", label: "5–20 min", test: (d) => d != null && d >= 300 && d < 1200 },
  { key: "lg", label: "20–60 min", test: (d) => d != null && d >= 1200 && d < 3600 },
  { key: "xl", label: "1 hr +", test: (d) => d != null && d >= 3600 },
];

const ACTIVE_STATES = new Set(["queued", "running", "awaiting_batch"]);

function AuthGate() {
  const [email, setEmail] = useState("");
  return (
    <div className="authgate">
      <div className="authgate__card">
        <span className="brand__mark" style={{ width: 48, height: 48 }}><BoardIcon size={24} /></span>
        <h1>Watch Later Librarian</h1>
        <p>Your Watch Later is a graveyard. Sign in and let the librarian sort it — your first 100 videos are free.</p>
        {isDevAuth ? (
          <form className="authgate__dev" onSubmit={(e) => { e.preventDefault(); if (email.includes("@")) { signInDev(email); location.reload(); } }}>
            <input type="email" placeholder="dev mode — any email" value={email}
              onChange={(e) => setEmail(e.target.value)} aria-label="Email for dev sign-in" />
            <button className="btn btn--primary" type="submit">Enter</button>
          </form>
        ) : (
          <button className="authgate__google" onClick={signInWithGoogle}>
            <GoogleIcon size={18} /> Continue with Google
          </button>
        )}
        <span className="authgate__fine">
          We only see your email. Your YouTube account stays yours — no passwords, no account access.
          {" "}<a href="/privacy.html">Privacy</a>
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [me, setMe] = useState(null);
  const [board, setBoard] = useState(null);
  const [job, setJob] = useState(null);
  const [view, setView] = useState("board");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState(null);
  const [duration, setDuration] = useState(null);
  const [sort, setSort] = useState("added-new");
  const [toast, setToast] = useState(null);
  const pollRef = useRef(null);
  const toastRef = useRef(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 4600);
  }, []);

  const reload = useCallback(async () => {
    const [m, b, j] = await Promise.all([api.getMe(), api.getBoard(), api.getCurrentJob()]);
    setMe(m);
    setBoard(b);
    setJob(j.job);
    return { m, b, j: j.job };
  }, []);

  // session
  useEffect(() => {
    hasSession().then(setAuthed);
    return onAuthChange(() => hasSession().then(setAuthed));
  }, []);

  // first load
  useEffect(() => {
    if (!authed) return;
    reload().catch((e) => showToast(e.message));
  }, [authed, reload, showToast]);

  // returning from Stripe checkout: wait for the webhook to land
  useEffect(() => {
    if (!authed || !location.search.includes("upgraded=1")) return;
    history.replaceState(null, "", "/app");
    let tries = 0;
    const t = setInterval(async () => {
      const m = await api.getMe().catch(() => null);
      if (m?.plan === "pro") {
        clearInterval(t);
        setMe(m);
        showToast("Welcome to Pro — sort the rest whenever you're ready ✦");
      } else if (++tries > 15) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [authed, showToast]);

  // poll the active job every 3s; on completion, refresh everything once
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!job || !ACTIVE_STATES.has(job.state)) return;
    pollRef.current = setInterval(async () => {
      const { job: fresh } = await api.getCurrentJob().catch(() => ({ job: null }));
      setJob(fresh);
      if (fresh && !ACTIVE_STATES.has(fresh.state)) {
        clearInterval(pollRef.current);
        const { m } = await reload();
        if (fresh.state === "completed") {
          showToast(`Sorted ${fresh.processed.toLocaleString()} videos into your board ✦`);
        } else if (fresh.error) {
          showToast(fresh.error);
        }
        void m;
      }
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [job?.id, job?.state, reload, showToast]);

  if (authed === null) return <div className="loading">loading…</div>;
  if (!authed) return <AuthGate />;
  if (!me || !board) return <div className="loading">loading…</div>;

  const totalVideos = Object.values(me.counts).reduce((a, b) => a + b, 0);
  const needsQuiz = !me.hasTaste && totalVideos === 0;
  const lockedCount = ACTIVE_STATES.has(job?.state) ? 0 : me.counts.unscanned;

  const matches = (list) => {
    let out = list;
    if (duration) {
      const bucket = DURATIONS.find((d) => d.key === duration);
      out = out.filter((v) => bucket.test(v.duration_seconds));
    }
    if (topic) out = out.filter((v) => parseTopics(v).includes(topic));
    return [...out].sort(SORTS[sort].fn);
  };

  const withQuery = (list) => {
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((v) => `${v.title} ${v.channel} ${v.reasoning ?? ""}`.toLowerCase().includes(q));
  };

  const topicCounts = (() => {
    const counts = new Map();
    for (const key of Object.keys(board)) {
      for (const v of board[key]) {
        for (const t of parseTopics(v)) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const move = async (id, category) => {
    await api.setCategory(id, category);
    showToast(`Moved to ${category} — the AI learns from your corrections ✦`);
    reload();
  };
  const dismiss = async (id) => { await api.dismissVideo(id); reload(); };
  const done = async (id) => { await api.markDone([id]); showToast("Marked done — it's on your cleanup checklist"); reload(); };

  const onImported = async (result) => {
    const bits = [`${result.added.toLocaleString()} new videos imported`];
    if (result.willClassify) bits.push(`sorting ${result.willClassify.toLocaleString()} now`);
    if (result.locked) bits.push(`${result.locked.toLocaleString()} waiting behind Pro`);
    showToast(bits.join(" · "));
    setView("board");
    await reload();
  };

  const chipsBar = (
    <div className="filters">
      <div className="filters__group" role="group" aria-label="Filter by length">
        <span className="filters__label">Length</span>
        <div className="filters__items">
          {DURATIONS.map((d) => (
            <button key={d.key} className={`chip chip--duration${duration === d.key ? " chip--active" : ""}`}
              onClick={() => setDuration(duration === d.key ? null : d.key)}
              aria-pressed={duration === d.key}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {topicCounts.length > 0 && (
        <div className="filters__group" role="group" aria-label="Filter by topic">
          <span className="filters__label">Topic</span>
          <div className="filters__items">
            {topicCounts.map(([t, n]) => (
              <button key={t} className={`chip${topic === t ? " chip--active" : ""}`}
                onClick={() => setTopic(topic === t ? null : t)} aria-pressed={topic === t}>
                {t} <span className="chip__count">{n}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const boardEmpty = totalVideos === 0;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setView("board")} aria-label="Back to the board">
          <span className="brand__mark"><BoardIcon size={18} /></span>
          <h1>watch-later-librarian</h1>
        </button>
        <span className={`plan-badge plan-badge--${me.plan}`}>{me.plan}</span>
        <div className="topbar__spacer" />
        {totalVideos > 0 && (
          <span className="wl-stat" title="scanned · waiting · total imported">
            {me.counts.scanned.toLocaleString()} sorted · {me.counts.unscanned.toLocaleString()} waiting
          </span>
        )}
        <button className="btn btn--primary" onClick={() => setView("import")}>
          <UploadIcon size={15} /> Import
        </button>
        <button className="btn btn--ghost" onClick={() => setView(view === "cleanup" ? "board" : "cleanup")}
          aria-label="Cleanup checklist">
          {view === "cleanup" ? <><BoardIcon size={15} /> Board</> : <><HistoryIcon size={15} /> Cleanup</>}
        </button>
        <button className="btn btn--ghost" onClick={() => setView("settings")} aria-label="Settings">
          <SettingsIcon size={15} />
        </button>
      </header>

      {job && ACTIVE_STATES.has(job.state) && (
        <JobProgress job={job} onCancelled={reload} />
      )}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}

      <main>
        {needsQuiz && view !== "import" && view !== "settings" ? (
          <Onboarding onDone={() => reload().then(() => setView("import"))} />
        ) : view === "settings" ? (
          <Settings me={me} onBack={() => setView("board")} onToast={showToast}
            onRetakeQuiz={() => { api.saveTaste({ interests: [], note: "" }); setView("quiz"); }} />
        ) : view === "quiz" ? (
          <Onboarding onDone={() => reload().then(() => setView("board"))} />
        ) : view === "import" ? (
          <ImportPanel onImported={onImported} />
        ) : view === "cleanup" ? (
          <CleanupChecklist />
        ) : ROWS.some((r) => r.key === view) ? (
          <CategoryView row={ROWS.find((r) => r.key === view)}
            videos={withQuery(matches(board[view]))} chips={chipsBar}
            query={query} onQuery={setQuery} sort={sort} onSort={setSort}
            onMove={move} onDismiss={dismiss} onDone={done}
            onBack={() => { setView("board"); setQuery(""); }} />
        ) : boardEmpty ? (
          <div className="empty-hero">
            <span className="empty-hero__icon"><UploadIcon size={30} /></span>
            <h2>Your library is empty</h2>
            <p>
              Import your Watch Later and the librarian sorts every video into five rows —
              what's worth learning from, worth watching, music, fun, and what's gone stale.
              Your first {me.freeQuota} are free.
            </p>
            <button className="btn btn--primary" onClick={() => setView("import")}>
              <UploadIcon size={15} /> Import your Watch Later
            </button>
          </div>
        ) : (
          <>
            {chipsBar}
            {ROWS.map((r) => (
              <Row key={r.key} label={r.label} tint={r.tint} icon={r.icon}
                videos={matches(board[r.key])} emptyLine={r.empty}
                onMove={move} onDismiss={dismiss} onDone={done}
                onOpen={() => setView(r.key)} />
            ))}
            {lockedCount > 0 && (
              <UpgradeBand me={me} lockedCount={lockedCount} onToast={showToast}
                onJobStarted={() => reload()} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
