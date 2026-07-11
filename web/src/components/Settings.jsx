import React, { useState } from "react";
import * as api from "../api.js";
import { signOut } from "../auth.js";
import { ArrowLeftIcon, LogOutIcon } from "./icons.jsx";

export default function Settings({ me, onBack, onToast, onRetakeQuiz }) {
  const [busy, setBusy] = useState(false);

  const managePlan = async () => {
    setBusy(true);
    try {
      const { url } = await api.portalUrl();
      location.href = url;
    } catch (e) {
      onToast(e.status === 400 ? "No subscription yet." : e.message);
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!window.confirm("Delete your account and every imported video? This cannot be undone.")) return;
    if (!window.confirm("Really delete everything?")) return;
    await api.deleteAccount();
    await signOut();
  };

  return (
    <div className="settings">
      <div className="catview__header">
        <button className="btn btn--ghost" onClick={onBack}><ArrowLeftIcon size={15} /> Back</button>
        <h2>Settings</h2>
      </div>

      <div className="settings__block">
        <h3>Account</h3>
        <div className="settings__row">
          <p>{me.email}</p>
          <button className="btn btn--ghost" onClick={() => signOut()}>
            <LogOutIcon size={14} /> Sign out
          </button>
        </div>
      </div>

      <div className="settings__block">
        <h3>Plan</h3>
        <div className="settings__row">
          <p>
            {me.plan === "pro"
              ? "Pro. Your whole backlog gets sorted."
              : `Free. Your first ${me.freeQuota} videos are sorted (${me.freeUsed} used).`}
          </p>
          {me.plan === "pro" && !me.isAdmin && (
            <button className="btn btn--ghost" disabled={busy} onClick={managePlan}>
              Manage subscription
            </button>
          )}
        </div>
      </div>

      <div className="settings__block">
        <h3>Taste profile</h3>
        <div className="settings__row">
          <p>
            {me.tasteProfile?.interests?.length
              ? `Interests: ${me.tasteProfile.interests.join(", ")}`
              : "No interests set. The AI judges generically."}
          </p>
          <button className="btn btn--ghost" onClick={onRetakeQuiz}>Edit</button>
        </div>
      </div>

      <div className="settings__block settings__danger">
        <h3>Danger zone</h3>
        <div className="settings__row">
          <p>Delete your account and every video you've imported. Instant and permanent.</p>
          <button className="btn btn--danger" onClick={deleteAccount}>Delete everything</button>
        </div>
      </div>
    </div>
  );
}
