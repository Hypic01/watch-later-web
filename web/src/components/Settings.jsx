import React, { useEffect, useState } from "react";
import * as api from "../api.js";
import { signOut } from "../auth.js";
import { ArrowLeftIcon, LogOutIcon } from "./icons.jsx";
import ExtensionConnection from "./ExtensionConnection.jsx";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatDate = (value) => DATE_FORMAT.format(new Date(value));

export default function Settings({
  me,
  onBack,
  onToast,
  onRetakeQuiz,
  extension,
  onConnectExtension,
  extensionBusy,
}) {
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokenBusy, setTokenBusy] = useState(null);
  const [generatedToken, setGeneratedToken] = useState(null);

  useEffect(() => {
    let active = true;
    api.listTokens()
      .then((items) => { if (active) setTokens(items); })
      .catch((e) => { if (active) onToast(e.message); })
      .finally(() => { if (active) setTokensLoading(false); });
    return () => { active = false; };
  }, [onToast]);

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

  const upgrade = async () => {
    setBusy(true);
    try {
      const { url } = await api.checkoutUrl();
      location.href = url;
    } catch (e) {
      onToast(
        e.status === 404
          ? "Pro isn't open yet, you're early! Everything you have stays free."
          : e.message
      );
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!window.confirm("Delete your account and every imported video? This cannot be undone.")) return;
    if (!window.confirm("Really delete everything?")) return;
    await api.deleteAccount();
    await signOut();
  };

  const generateBridgeToken = async () => {
    setTokenBusy("create");
    try {
      const created = await api.createToken({ scope: "bridge", label: "Vault bridge" });
      const { token, ...metadata } = created;
      setGeneratedToken({ id: metadata.id, value: token });
      setTokens((current) => [metadata, ...current.filter((item) => item.id !== metadata.id)]);
      onToast("Bridge token generated.");
    } catch (e) {
      onToast(e.message);
    } finally {
      setTokenBusy(null);
    }
  };

  const revokeToken = async (token) => {
    const name = token.label || "this app";
    if (!window.confirm(`Revoke access for ${name}?`)) return;
    setTokenBusy(token.id);
    try {
      await api.revokeToken(token.id);
      setTokens((current) => current.filter((item) => item.id !== token.id));
      setGeneratedToken((current) => current?.id === token.id ? null : current);
      onToast("Access revoked.");
    } catch (e) {
      onToast(e.message);
    } finally {
      setTokenBusy(null);
    }
  };

  const copyGeneratedToken = async () => {
    try {
      await navigator.clipboard.writeText(generatedToken.value);
      onToast("Token copied.");
    } catch {
      onToast("Copy failed. Select the token and copy it manually.");
    }
  };

  const connectExtension = async () => {
    const created = await onConnectExtension();
    if (!created) return;
    const { token: _token, ...metadata } = created;
    setTokens((current) => [metadata, ...current.filter((item) => item.id !== metadata.id)]);
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
            {me.betaPro
              ? "Beta: Pro is free for everyone right now. Paid plans arrive after the beta."
              : me.plan === "pro"
              ? me.proEndsAt
                ? `Pro${me.proInterval === "year" ? " (yearly)" : me.proInterval === "month" ? " (monthly)" : ""} until ${formatDate(me.proEndsAt)}. Your library stays sorted after that.`
                : `Pro${me.proInterval === "year" ? ", billed yearly" : me.proInterval === "month" ? ", billed monthly" : ""}. Your whole backlog, unlimited TL;DRs.`
              : `Free. Your newest ${Number(me.videoCap).toLocaleString()} videos, ` +
                `${Number(me.summariesUsed).toLocaleString()} of ${Number(me.summaryQuota).toLocaleString()} TL;DRs used this month.`}
          </p>
          {me.betaPro ? null : me.plan === "pro" && !me.isAdmin ? (
            <button className="btn btn--ghost" disabled={busy} onClick={managePlan}>
              Manage subscription
            </button>
          ) : me.plan !== "pro" ? (
            <button className="btn btn--primary" disabled={busy} onClick={upgrade}>
              Upgrade to Pro
            </button>
          ) : null}
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

      <div className="settings__block">
        <div className="settings__section-head">
          <div>
            <h3>Connected apps</h3>
            <p className="settings__hint">Review apps that can send videos to your library.</p>
          </div>
          {me.isAdmin ? (
            <button className="btn btn--ghost" disabled={tokenBusy !== null || generatedToken !== null}
              onClick={generateBridgeToken}>
              Generate bridge token
            </button>
          ) : null}
        </div>

        <ExtensionConnection extension={extension} onConnect={connectExtension}
          busy={extensionBusy} surface="settings" />

        {generatedToken ? (
          <div className="settings__token-reveal">
            <p id="bridge-token-warning" role="status">Copy this token now. It will not be shown again.</p>
            <div className="settings__secret-row">
              <input value={generatedToken.value} readOnly spellCheck="false" autoComplete="off"
                aria-label="Generated bridge token" aria-describedby="bridge-token-warning"
                onFocus={(event) => event.currentTarget.select()} />
              <button className="btn btn--primary" onClick={copyGeneratedToken}>Copy token</button>
              <button className="btn btn--ghost" onClick={() => setGeneratedToken(null)}>Done</button>
            </div>
          </div>
        ) : null}

        {tokensLoading ? (
          <p className="settings__hint">Loading connected apps…</p>
        ) : tokens.length === 0 ? (
          <p className="settings__hint">No connected apps yet.</p>
        ) : (
          <div className="settings__tokens">
            {tokens.map((token) => (
              <div className="settings__token" key={token.id}>
                <div className="settings__token-copy">
                  <div className="settings__token-title">
                    <strong>{token.label || "Connected app"}</strong>
                    <span>{token.scope === "bridge" ? "Bridge" : "Imports"}</span>
                  </div>
                  <p>
                    Created {formatDate(token.created_at)}. {token.last_used_at
                      ? `Last used ${formatDate(token.last_used_at)}.`
                      : "Never used."}
                  </p>
                </div>
                <button className="btn btn--danger" disabled={tokenBusy !== null}
                  onClick={() => revokeToken(token)} aria-label={`Revoke ${token.label || "connected app"}`}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
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
