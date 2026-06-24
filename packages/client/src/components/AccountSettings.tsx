import { useState, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { authClient } from "../lib/auth";

/**
 * Settings → Account tab. The single place to manage the signed-in account:
 * name + email, password, 2FA (TOTP), passkeys (WebAuthn), and sign-out.
 * Only mounted when the server's AUTH_ENABLED flag is on (the tab is gated in
 * SettingsModal); the App-level gate guarantees a session exists here.
 */

// ponytail: WebAuthn needs a secure context. localhost is treated as secure;
// a raw LAN IP over http is not. Hide passkey UI there so it doesn't silently fail.
export const PASSKEY_SECURE =
  typeof window === "undefined" ||
  location.protocol === "https:" ||
  ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

export function AccountSettings() {
  const session = authClient.useSession();
  const user = session.data?.user;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto custom-scrollbar p-1 pr-2">
      <ProfileSection name={user?.name} email={user?.email} onUpdated={() => session.refetch?.()} />
      <PasswordSection />
      <TwoFactorSetup />
      <PasskeySection />
      <Section title="Session" status="">
        <button
          onClick={async () => { await authClient.signOut(); await session.refetch?.(); }}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800"
        >
          Sign out
        </button>
        <p className="mt-1 text-[11px] text-ink-500">You'll be returned to the sign-in screen.</p>
      </Section>
    </div>
  );
}

// ── Profile: name + email ──────────────────────────────────────────────────

function ProfileSection({ name, email, onUpdated }: { name?: string; email?: string; onUpdated: () => void }) {
  const [editName, setEditName] = useState(name ?? "");
  const [editEmail, setEditEmail] = useState(email ?? "");
  const [nameSaved, setNameSaved] = useState(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setEditName(name ?? ""); }, [name]);
  useEffect(() => { setEditEmail(email ?? ""); }, [email]);

  const saveName = useCallback(async () => {
    if (editName === name) return;
    setBusy(true);
    try {
      const res = await authClient.updateUser({ name: editName });
      if (res.error) { setEmailMsg(res.error.message?.replace(/\.$/, "") || "Could not update name"); setEmailErr(true); }
      else { setNameSaved(true); onUpdated(); setTimeout(() => setNameSaved(false), 1500); }
    } finally { setBusy(false); }
  }, [editName, name, onUpdated]);

  const saveEmail = useCallback(async () => {
    if (editEmail === email) return;
    setBusy(true); setEmailMsg(null); setEmailErr(false);
    try {
      // changeEmail sends a verification to the new address; without an email
      // transport configured it errors — surface that honestly.
      const res = await authClient.changeEmail({ newEmail: editEmail });
      if (res.error) { setEmailMsg(res.error.message?.replace(/\.$/, "") || "Could not change email"); setEmailErr(true); }
      else { setEmailMsg("Verification email sent to the new address."); setEmailErr(false); onUpdated(); }
    } catch (e: any) {
      setEmailMsg(e?.message || "Could not change email"); setEmailErr(true);
    } finally { setBusy(false); }
  }, [editEmail, email, onUpdated]);

  return (
    <Section title="Profile" status="">
      <Field label="Name">
        <div className="flex gap-2">
          <input value={editName} onChange={(e) => setEditName(e.target.value)} autoComplete="name" className="auth-input flex-1" />
          <button onClick={saveName} disabled={busy || editName === name}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400 disabled:opacity-50">
            {nameSaved ? "Saved" : busy ? "…" : "Save"}
          </button>
        </div>
      </Field>
      <div className="mt-2">
        <Field label="Email">
          <div className="flex gap-2">
            <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} autoComplete="email" className="auth-input flex-1" />
            <button onClick={saveEmail} disabled={busy || editEmail === email}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400 disabled:opacity-50">
              {busy ? "…" : "Save"}
            </button>
          </div>
        </Field>
        {emailMsg && <p className={`mt-1 text-[11px] ${emailErr ? "text-red-400" : "text-emerald-400"}`}>{emailMsg}</p>}
      </div>
    </Section>
  );
}

// ── Password ────────────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const mismatch = next !== "" && confirm !== "" && next !== confirm;

  const submit = useCallback(async () => {
    if (!current || !next || next !== confirm) return;
    setBusy(true); setMsg(null); setErr(false);
    try {
      const res = await authClient.changePassword({ currentPassword: current, newPassword: next });
      if (res.error) { setMsg(res.error.message?.replace(/\.$/, "") || "Could not change password"); setErr(true); }
      else { setMsg("Password updated."); setErr(false); setCurrent(""); setNext(""); setConfirm(""); }
    } catch (e: any) {
      setMsg(e?.message || "Could not change password"); setErr(true);
    } finally { setBusy(false); }
  }, [current, next, confirm]);

  return (
    <Section title="Password" status="">
      <Field label="Current password">
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className="auth-input" />
      </Field>
      <div className="mt-2">
        <Field label="New password">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className="auth-input" minLength={8} />
        </Field>
      </div>
      <div className="mt-2">
        <Field label="Confirm new password">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className="auth-input" minLength={8} />
        </Field>
        {mismatch && <p className="mt-1 text-[11px] text-red-400">Passwords don't match.</p>}
      </div>
      <button onClick={submit} disabled={busy || !current || !next || mismatch}
        className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400 disabled:opacity-50">
        {busy ? "…" : "Update password"}
      </button>
      {msg && <p className={`mt-1 text-[11px] ${err ? "text-red-400" : "text-emerald-400"}`}>{msg}</p>}
    </Section>
  );
}

// ── Two-factor (TOTP) ───────────────────────────────────────────────────────

function TwoFactorSetup() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [totpPassword, setTotpPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reflect current 2FA state from the session (user.twoFactorEnabled).
  const session = authClient.useSession();
  useEffect(() => {
    setEnabled(!!(session.data?.user as any)?.twoFactorEnabled);
  }, [session.data]);

  const start = useCallback(async () => {
    if (!totpPassword) { setError("Enter your password to enable 2FA"); return; }
    setBusy(true);
    setError(null);
    try {
      // better-auth requires the current password to authorize 2FA changes.
      const res = await authClient.twoFactor.enable({ password: totpPassword });
      if (res.error) { setError(res.error.message?.replace(/\.$/, "") || "Could not start 2FA"); return; }
      const uri = (res.data as any)?.totpURI || (res.data as any)?.uri;
      const codes = (res.data as any)?.backupCodes;
      if (uri) setQr(await QRCode.toDataURL(String(uri), { margin: 1, width: 200 }));
      if (Array.isArray(codes)) setBackupCodes(codes as string[]);
    } catch (err: any) {
      setError(err?.message || "2FA setup error");
    } finally {
      setBusy(false);
    }
  }, [totpPassword]);

  const verify = useCallback(async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.verifyTotp({ code });
      if (res.error) { setError(res.error.message?.replace(/\.$/, "") || "Invalid code"); return; }
      setEnabled(true);
      setQr(null);
      setCode("");
    } catch (err: any) {
      setError(err?.message || "Verify error");
    } finally {
      setBusy(false);
    }
  }, [code]);

  const disable = useCallback(async () => {
    if (!totpPassword) { setError("Enter your password to disable 2FA"); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.disable({ password: totpPassword });
      if (res.error) { setError(res.error.message?.replace(/\.$/, "") || "Could not disable"); return; }
      setEnabled(false);
      setTotpPassword("");
    } catch (err: any) {
      setError(err?.message || "Disable error");
    } finally {
      setBusy(false);
    }
  }, [totpPassword]);

  if (enabled) {
    return (
      <Section title="Two-factor (TOTP)" status="enabled">
        <input type="password" value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)}
          autoComplete="current-password" placeholder="Current password" className="auth-input" />
        <button onClick={disable} disabled={busy || !totpPassword}
          className="mt-2 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-50">
          {busy ? "…" : "Disable 2FA"}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </Section>
    );
  }

  return (
    <Section title="Two-factor (TOTP)" status={qr ? "verify" : "off"}>
      {!qr ? (
        <div className="space-y-2">
          <input type="password" value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)}
            autoComplete="current-password" placeholder="Current password" className="auth-input" />
          <button onClick={start} disabled={busy || !totpPassword}
            className="w-full rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400 disabled:opacity-50">
            {busy ? "…" : "Enable 2FA"}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-ink-400">Scan with an authenticator app, then enter the 6-digit code.</p>
          {qr && <img src={qr} alt="2FA QR code" className="rounded-lg border border-ink-700" />}
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6}
            placeholder="123456" className="auth-input" />
          <button onClick={verify} disabled={busy || !code.trim()}
            className="w-full rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400 disabled:opacity-50">
            Verify & enable
          </button>
          {backupCodes && (
            <details className="text-[11px] text-ink-500">
              <summary className="cursor-pointer hover:text-ink-300">Backup codes — save now</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-ink-950 p-2 text-ink-300">{backupCodes.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Section>
  );
}

// ── Passkeys (WebAuthn): register + list + delete ──────────────────────────

interface PasskeyRow { id: string; name?: string; createdAt?: string }

function PasskeySection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListErr(null);
    try {
      const res = await authClient.passkey.listUserPasskeys();
      if (res.error) { setListErr(res.error.message?.replace(/\.$/, "") || "Could not list passkeys"); return; }
      const rows = (res.data as any)?.passkeys ?? (Array.isArray(res.data) ? res.data : []);
      setPasskeys(rows as PasskeyRow[]);
    } catch (e: any) {
      setListErr(e?.message || "Could not list passkeys");
    }
  }, []);

  useEffect(() => { if (PASSKEY_SECURE) load(); }, [load]);

  const add = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await authClient.passkey.addPasskey({});
      if (res.error) { setError(res.error.message?.replace(/\.$/, "") || "Could not add passkey"); return; }
      await load();
    } catch (e: any) {
      setError(e?.message || "Passkey error");
    } finally { setBusy(false); }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    setBusy(true); setError(null);
    try {
      const res = await authClient.passkey.deletePasskey({ id });
      if (res.error) { setError(res.error.message?.replace(/\.$/, "") || "Could not delete passkey"); return; }
      await load();
    } catch (e: any) {
      setError(e?.message || "Passkey error");
    } finally { setBusy(false); }
  }, [load]);

  if (!PASSKEY_SECURE) {
    return (
      <Section title="Passkey" status="off">
        <p className="text-[11px] text-ink-500">Passkey requires HTTPS (or localhost). Enable TLS to use passkeys.</p>
      </Section>
    );
  }

  return (
    <Section title="Passkey" status={passkeys.length > 0 ? "enabled" : "off"}>
      <button onClick={add} disabled={busy}
        className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-50">
        {busy ? "…" : "Add passkey"}
      </button>
      {passkeys.length > 0 && (
        <ul className="mt-2 space-y-1">
          {passkeys.map(p => (
            <li key={p.id} className="flex items-center justify-between rounded bg-ink-950/60 px-2 py-1.5">
              <span className="truncate text-xs text-ink-300">{p.name || "Passkey"}</span>
              <button onClick={() => remove(p.id)} disabled={busy}
                className="ml-2 text-[11px] text-ink-500 hover:text-red-400 disabled:opacity-50">Remove</button>
            </li>
          ))}
        </ul>
      )}
      {listErr && <p className="text-xs text-red-400">{listErr}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Section>
  );
}

// ── Shared presentational helpers ───────────────────────────────────────────

export function Section({ title, status, children }: { title: string; status: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-ink-200">{title}</span>
        {status && <span className={`text-[10px] uppercase tracking-wide ${status === "enabled" ? "text-emerald-400" : "text-ink-600"}`}>{status}</span>}
      </div>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-400">{label}</span>
      {children}
    </label>
  );
}
