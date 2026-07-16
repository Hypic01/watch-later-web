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
import VideoDetail from "./components/VideoDetail.jsx";
import {
  availabilitySummary,
  createExtensionClient,
  isChromiumBrowser,
  WLL_SYNC_DONE,
  WLL_SYNC_ERROR,
  WLL_SYNC_PHASE,
  WLL_SYNC_PROGRESS,
} from "./extension.js";
import {
  LearnIcon, EyeIcon, MusicIcon, GamepadIcon, ArchiveIcon, BoardIcon,
  HistoryIcon, SettingsIcon, UploadIcon, GoogleIcon, SyncIcon,
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
        <p>Your Watch Later is a graveyard. Sign in and let the librarian sort it. Your first 100 videos are free.</p>
        {isDevAuth ? (
          <form className="authgate__dev" onSubmit={(e) => { e.preventDefault(); if (email.includes("@")) { signInDev(email); location.reload(); } }}>
            <input type="email" placeholder="dev mode: any email" value={email}
              onChange={(e) => setEmail(e.target.value)} aria-label="Email for dev sign-in" />
            <button className="btn btn--primary" type="submit">Enter</button>
          </form>
        ) : (
          <button className="authgate__google" onClick={signInWithGoogle}>
            <GoogleIcon size={18} /> Continue with Google
          </button>
        )}
        <span className="authgate__fine">
          We only see your email. Your YouTube account stays yours. No passwords, no account access.
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
  const [focus, setFocus] = useState(null);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState(null);
  const [duration, setDuration] = useState(null);
  const [sort, setSort] = useState("added-new");
  const [toast, setToast] = useState(null);
  const [extensionClient] = useState(() => createExtensionClient());
  const [isChromium] = useState(() => isChromiumBrowser());
  const [extensionState, setExtensionState] = useState({
    checking: true,
    present: false,
    version: null,
    status: null,
    progress: null,
  });
  const [extensionBusy, setExtensionBusy] = useState(false);
  const pollRef = useRef(null);
  const toastRef = useRef(null);
  const failNoticeRef = useRef(null);
  const doneNoticeRef = useRef(null);
  const activeSeenRef = useRef(new Set());
  const meEmail = me?.email || "";

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 4600);
  }, []);

  const reload = useCallback(async () => {
    // Job first, then the board. The job fetch piggybacks the serverless
    // worker tick, which can sort a small backlog within this very request —
    // fetching in parallel let the board land before the tick finished, so
    // freshly sorted videos didn't appear until a manual browser refresh.
    const j = await api.getCurrentJob();
    if (j.job && ACTIVE_STATES.has(j.job.state)) activeSeenRef.current.add(j.job.id);
    const [m, b] = await Promise.all([api.getMe(), api.getBoard()]);
    setMe(m);
    setBoard(b);
    setJob(j.job);
    return { m, b, j: j.job };
  }, []);

  // Show the sorting bar the instant a job starts instead of waiting for the
  // next fetch. The poll effect and the announcement effects take over from
  // here; activeSeen marks the job as started-by-this-session so completion
  // gets announced even if it finishes before the first poll.
  const adoptJob = useCallback((startedJob) => {
    activeSeenRef.current.add(startedJob.id);
    setJob(startedJob);
  }, []);

  const onImported = useCallback(async (result) => {
    if (result.skipped) {
      showToast(result.reason === "SORT_RUNNING"
        ? "Sync skipped. A sort is already running."
        : "Sync skipped. Try again after the import limit resets.");
      setView("board");
      await reload();
      return;
    }
    const added = Number(result.added) || 0;
    const willClassify = Number(result.willClassify) || 0;
    const locked = Number(result.locked) || 0;
    const bits = [`${added.toLocaleString()} new videos imported`];
    if (willClassify) bits.push(`sorting ${willClassify.toLocaleString()} now`);
    if (locked) bits.push(`${locked.toLocaleString()} waiting behind Pro`);
    const availability = availabilitySummary(result);
    if (availability) bits.push(availability);
    if (result.jobId && willClassify > 0) {
      adoptJob({ id: result.jobId, state: "queued", mode: null, tier: null, total: willClassify, processed: 0, failed: 0, error: null });
    }
    showToast(bits.join(" · "));
    setView("board");
    await reload();
  }, [adoptJob, reload, showToast]);

  const onSummaryUsed = useCallback((used, quota) => {
    setMe((current) => current ? {
      ...current,
      summariesUsed: Number.isFinite(Number(used)) ? Number(used) : current.summariesUsed,
      summaryQuota: Number.isFinite(Number(quota)) ? Number(quota) : current.summaryQuota,
    } : current);
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
        showToast("Welcome to Pro. Sort the rest whenever you're ready ✦");
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
      if (fresh && ACTIVE_STATES.has(fresh.state)) activeSeenRef.current.add(fresh.id);
      setJob(fresh);
      // Completion and failure handling live in the announcement effects
      // below, so a job that finishes faster than one poll interval — or
      // inside the very request that started it — is treated identically.
      if (fresh && !ACTIVE_STATES.has(fresh.state)) clearInterval(pollRef.current);
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [job?.id, job?.state]);

  // Announce a failed job's reason exactly once per job — including jobs that
  // failed before this client ever saw them active. A batch submit can be
  // rejected within the very poll that created the job, so without this the
  // Sync / "Sort the rest" buttons appear to do nothing at all.
  useEffect(() => {
    if (job?.state === "failed" && job.error && failNoticeRef.current !== job.id) {
      failNoticeRef.current = job.id;
      showToast(job.error);
      reload();
    }
  }, [job, reload, showToast]);

  // Announce a finished sort and refresh the board exactly once per job this
  // session started or watched. Small sorts complete inside the request that
  // created them, so waiting for an active→done transition misses them and
  // the board looks unchanged until a manual refresh.
  useEffect(() => {
    if (job?.state === "completed" && activeSeenRef.current.has(job.id) && doneNoticeRef.current !== job.id) {
      doneNoticeRef.current = job.id;
      showToast(`Sorted ${Number(job.processed).toLocaleString()} videos into your board ✦`);
      reload();
    }
  }, [job, reload, showToast]);

  // Detect one configured extension ID and keep one external Port subscription.
  useEffect(() => {
    if (!meEmail) return;
    let active = true;
    let port = null;
    let reconnectTimer = null;

    const payloadOf = (message) => message?.payload || message || {};
    const onPortMessage = (message) => {
      if (!active) return;
      const payload = payloadOf(message);
      if (message?.type === WLL_SYNC_PHASE) {
        setExtensionState((current) => ({
          ...current,
          status: { ...current.status, syncing: true },
          progress: {
            phase: payload.phase,
            count: current.progress?.count || 0,
            expectedTotal: current.progress?.expectedTotal || null,
          },
        }));
        return;
      }
      if (message?.type === WLL_SYNC_PROGRESS) {
        setExtensionState((current) => ({
          ...current,
          status: { ...current.status, syncing: true },
          progress: {
            phase: "collecting",
            count: Number(payload.count) || 0,
            expectedTotal: Number(payload.expectedTotal) || null,
          },
        }));
        return;
      }
      if (message?.type === WLL_SYNC_DONE) {
        setExtensionState((current) => ({
          ...current,
          status: {
            ...current.status,
            syncing: false,
            lastSyncAt: new Date().toISOString(),
            lastResult: payload,
          },
          progress: null,
        }));
        void onImported(payload);
        return;
      }
      if (message?.type === WLL_SYNC_ERROR) {
        setExtensionState((current) => ({
          ...current,
          status: {
            ...current.status,
            connected: payload.code === "TOKEN_REJECTED" ? false : current.status?.connected,
            syncing: false,
            lastResult: payload,
          },
          progress: null,
        }));
        const fallback = payload.code === "SIGNED_OUT"
          ? "Sign in to YouTube, then try Sync again."
          : payload.code === "TOKEN_REJECTED"
            ? "Connect the extension again."
            : "The extension could not finish the sync. Try again.";
        showToast(payload.error || fallback);
      }
    };

    const connectPort = () => {
      if (!active || !extensionClient.extensionId) return;
      try {
        port = extensionClient.connectPort();
        port.onMessage.addListener(onPortMessage);
        port.onDisconnect.addListener(() => {
          port = null;
          if (active) reconnectTimer = setTimeout(connectPort, 1200);
        });
      } catch {
        if (active) reconnectTimer = setTimeout(connectPort, 1200);
      }
    };

    const detect = async () => {
      setExtensionState((current) => ({ ...current, checking: true }));
      const found = await extensionClient.detect();
      if (!active) return;
      if (!found.present) {
        setExtensionState({ checking: false, present: false, version: null, status: null, progress: null });
        return;
      }
      try {
        const status = await extensionClient.getStatus();
        if (!active) return;
        setExtensionState({
          checking: false,
          present: true,
          version: found.version,
          status,
          progress: status.syncing ? { phase: "opening", count: 0, expectedTotal: null } : null,
        });
        connectPort();
        // Reconcile a job that may have started after the first page load but
        // before this Port attached. This reuses the existing job state and
        // polling path rather than introducing a second progress loop.
        void reload().catch(() => {});
      } catch {
        if (!active) return;
        setExtensionState({ checking: false, present: true, version: found.version, status: null, progress: null });
        connectPort();
      }
    };

    void detect();
    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      try { port?.disconnect(); } catch { /* The extension may already be gone. */ }
    };
  }, [extensionClient, meEmail, onImported, reload, showToast]);

  const connectExtension = useCallback(async () => {
    if (!meEmail) return null;
    setExtensionBusy(true);
    let created = null;
    let handedOff = false;
    try {
      created = await api.createToken({ scope: "imports", label: "Chrome extension" });
      const response = await extensionClient.setToken({
        token: created.token,
        apiUrl: location.origin,
        email: meEmail,
      });
      if (!response?.ok) throw new Error(response?.error || "The extension could not connect.");
      handedOff = true;
      const status = await extensionClient.getStatus().catch(() => ({
        connected: true,
        email: meEmail,
        lastSyncAt: null,
        lastResult: null,
        syncing: false,
        autoSync: false,
      }));
      setExtensionState((current) => ({ ...current, present: true, status }));
      showToast("Extension connected.");
      return created;
    } catch (error) {
      if (created && !handedOff) await api.revokeToken(created.id).catch(() => {});
      showToast(error.message || "The extension could not connect.");
      return null;
    } finally {
      setExtensionBusy(false);
    }
  }, [extensionClient, meEmail, showToast]);

  const syncExtension = useCallback(async () => {
    setExtensionState((current) => ({
      ...current,
      status: { ...current.status, syncing: true },
      progress: { phase: "opening", count: 0, expectedTotal: null },
    }));
    try {
      const response = await extensionClient.sync("delta");
      if (response?.started === false && !response.error) return;
      if (!response?.started) throw new Error(response?.error || "The extension could not start the sync.");
    } catch (error) {
      setExtensionState((current) => ({
        ...current,
        status: { ...current.status, syncing: false },
        progress: null,
      }));
      showToast(error.message || "The extension could not start the sync.");
    }
  }, [extensionClient, showToast]);

  if (authed === null) return <div className="loading">loading…</div>;
  if (!authed) return <AuthGate />;
  if (!me || !board) return <div className="loading">loading…</div>;

  const totalVideos = Object.values(me.counts).reduce((a, b) => a + b, 0);
  const needsQuiz = !me.hasTaste && totalVideos === 0;
  const lockedCount = ACTIVE_STATES.has(job?.state) ? 0 : me.counts.unscanned;
  const connectedEmail = extensionState.status?.email?.trim().toLowerCase() || "";
  const accountEmail = me.email.trim().toLowerCase();
  const extensionMismatch = Boolean(connectedEmail && connectedEmail !== accountEmail);
  const extension = {
    checking: extensionState.checking,
    present: extensionState.present,
    connected: Boolean(extensionState.status?.connected),
    mismatch: extensionMismatch,
    accountEmail: me.email,
    isChromium,
  };
  const extensionConnected = extension.present && extension.connected && !extension.mismatch;
  const extensionSyncing = Boolean(extensionState.status?.syncing || extensionState.progress);

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
    setFocus((current) => current?.id === id ? { ...current, category } : current);
    showToast(`Moved to ${category}. The AI learns from your corrections ✦`);
    reload();
  };
  const dismiss = async (id) => { await api.dismissVideo(id); reload(); };
  const done = async (id) => { await api.markDone([id]); showToast("Marked done. It's on your cleanup checklist"); reload(); };
  const openDetail = (video) => setFocus(video);
  const detailRow = focus ? ROWS.find((row) => row.key === focus.category) : null;

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
        <button className="brand" onClick={() => { setFocus(null); setView("board"); }} aria-label="Back to the board">
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
        {extensionConnected ? (
          <button className="btn btn--ghost" disabled={extensionSyncing} onClick={syncExtension}>
            <SyncIcon size={15} /> {extensionSyncing ? "Syncing…" : "Sync"}
          </button>
        ) : null}
        <button className="btn btn--primary" onClick={() => { setFocus(null); setView("import"); }}>
          <UploadIcon size={15} /> Import
        </button>
        <button className="btn btn--ghost" onClick={() => {
          setFocus(null);
          setView(view === "cleanup" ? "board" : "cleanup");
        }}
          aria-label="Cleanup checklist">
          {view === "cleanup" ? <><BoardIcon size={15} /> Board</> : <><HistoryIcon size={15} /> Cleanup</>}
        </button>
        <button className="btn btn--ghost" onClick={() => { setFocus(null); setView("settings"); }} aria-label="Settings">
          <SettingsIcon size={15} />
        </button>
      </header>

      {extensionState.progress || (job && ACTIVE_STATES.has(job.state)) ? (
        <JobProgress job={job} collection={extensionState.progress} onCancelled={reload} />
      ) : null}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}

      <main>
        {focus ? (
          <VideoDetail video={focus} rowMeta={detailRow} me={me}
            extensionPresent={extensionState.present}
            fetchTranscriptFromExtension={extensionClient.fetchTranscript}
            onBack={() => setFocus(null)} onMove={move} onDismiss={dismiss}
            onToast={showToast} onSummaryUsed={onSummaryUsed}
            onLearn={() => showToast("Learn sessions are coming soon.")} />
        ) : needsQuiz && view !== "import" && view !== "settings" ? (
          <Onboarding onDone={() => reload().then(() => setView("import"))} />
        ) : view === "settings" ? (
          <Settings me={me} onBack={() => setView("board")} onToast={showToast}
            onRetakeQuiz={() => { api.saveTaste({ interests: [], note: "" }); setView("quiz"); }}
            extension={extension} onConnectExtension={connectExtension}
            extensionBusy={extensionBusy} />
        ) : view === "quiz" ? (
          <Onboarding onDone={() => reload().then(() => setView("board"))} />
        ) : view === "import" ? (
          <ImportPanel onImported={onImported} extension={extension}
            onConnectExtension={connectExtension} extensionBusy={extensionBusy}
            extensionConnected={extensionConnected} onSyncExtension={syncExtension}
            extensionSyncing={extensionSyncing} />
        ) : view === "cleanup" ? (
          <CleanupChecklist />
        ) : ROWS.some((r) => r.key === view) ? (
          <CategoryView row={ROWS.find((r) => r.key === view)}
            videos={withQuery(matches(board[view]))} chips={chipsBar}
            query={query} onQuery={setQuery} sort={sort} onSort={setSort}
            onMove={move} onDismiss={dismiss} onDone={done} onOpenDetail={openDetail}
            onBack={() => { setView("board"); setQuery(""); }} />
        ) : boardEmpty ? (
          <div className="empty-hero">
            <span className="empty-hero__icon"><UploadIcon size={30} /></span>
            <h2>Your library is empty</h2>
            <p>
              Import your Watch Later and the librarian sorts every video into five rows:
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
                onOpenDetail={openDetail}
                onOpen={() => setView(r.key)} />
            ))}
            {job?.state === "failed" && job.error ? (
              <div className="jobfail" role="alert">
                <b>The last sort didn't run</b>
                <p>{job.error}</p>
              </div>
            ) : null}
            {lockedCount > 0 && (
              <UpgradeBand me={me} lockedCount={lockedCount} onToast={showToast}
                onJobStarted={(r) => adoptJob({
                  id: r.jobId, state: "queued", mode: null, tier: null,
                  total: Number(r.willClassify) || 0, processed: 0, failed: 0, error: null,
                })} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
