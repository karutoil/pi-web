import { useState, useCallback } from "react";
import { authClient } from "../lib/auth";
import { PASSKEY_SECURE, Field } from "./AccountSettings";

/**
 * Sign-in / first-run gate. Email+password sign-in (or sign-up) plus passkey
 * sign-in where supported. Sits in front of the app when the server's
 * AUTH_ENABLED flag is on. Account + security management lives in Settings → Account.
 */

export function SignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-ink-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900/80 p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          <span className="text-2xl">🪡</span>
          <div>
            <h1 className="text-base font-semibold text-ink-100">PI Web</h1>
            <p className="text-[11px] text-ink-500">Authentication required</p>
          </div>
        </div>
        <AuthForm onSignedIn={onSignedIn} />
      </div>
    </div>
  );
}

function AuthForm({ onSignedIn }: { onSignedIn?: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });
      if (res.error) {
        setError(res.error.message?.replace(/\.$/, "") || "Sign-in failed");
      } else {
        // The parent (App) refetches its own session via onSignedIn.
        onSignedIn?.();
      }
    } catch (err: any) {
      setError(err?.message || "Network error");
    } finally {
      setBusy(false);
    }
  }, [busy, email, password, name, mode, onSignedIn]);

  const usePasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.passkey({ autoFill: false });
      if (res.error) setError(res.error.message?.replace(/\.$/, "") || "Passkey sign-in failed");
      else onSignedIn?.();
    } catch (err: any) {
      setError(err?.message || "Passkey error");
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  return (
    <form onSubmit={submit} className="space-y-3">
      {mode === "signup" && (
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name"
            className="auth-input" required />
        </Field>
      )}
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" className="auth-input" required autoFocus />
      </Field>
      <Field label="Password">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          className="auth-input" required minLength={8} />
      </Field>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy}
        className="w-full rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-ink-950 transition hover:bg-amber-400 disabled:opacity-50">
        {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
      </button>
      {PASSKEY_SECURE && (
        <button type="button" onClick={usePasskey} disabled={busy}
          className="w-full rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200 transition hover:bg-ink-800 disabled:opacity-50">
          Sign in with passkey
        </button>
      )}
      <button type="button" onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
        className="block w-full text-center text-xs text-ink-500 hover:text-ink-300">
        {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
