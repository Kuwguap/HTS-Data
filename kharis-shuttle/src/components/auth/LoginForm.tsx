"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { ApiClientError, api } from "@/lib/api-client";
import type { PublicProfile } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/validation/common";

export type LoginFormProps = {
  /** In-app path to return to after login. Validated again here (same-origin only); unsafe values are dropped. */
  next?: string;
  /** Show the "account deactivated" notice (from /login?deactivated=1). */
  deactivated?: boolean;
  /** Hostel office number for the "forgot PIN" hint. */
  enquiryPhone?: string | null;
};

type LoginResponse = { profile: PublicProfile; home: string };

export function LoginForm({ next: rawNext, deactivated, enquiryPhone }: LoginFormProps) {
  const router = useRouter();
  // Never trust the prop blindly: only a same-origin absolute path survives.
  const next = safeNextPath(rawNext, "") || undefined;
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; pin?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      const res = await api.post<LoginResponse>("/api/auth/login", { username: username.trim().toLowerCase(), pin });
      if (!res.profile.onboarded_at) {
        // /welcome forwards `next` once onboarding is done.
        router.replace(next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome");
      } else {
        router.replace(next ?? safeNextPath(res.home));
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "VALIDATION") {
          setFieldErrors({ username: err.fieldError("username"), pin: err.fieldError("pin") });
          setError(err.fieldError("username") || err.fieldError("pin") ? null : err.message);
        } else {
          // INVALID_CREDENTIALS (uniform), LOCKED (message carries the minutes), FORBIDDEN (deactivated)…
          setError(err.message);
        }
      } else {
        setError("Something went wrong. Try again.");
      }
      setBusy(false);
    }
  };

  const tel = enquiryPhone ? enquiryPhone.replace(/\s+/g, "") : null;

  return (
    <>
      {deactivated ? (
        <Banner tone="red" icon="⛔">
          This account is deactivated. Contact the hostel office.
        </Banner>
      ) : null}
      <Card title="Log in">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field
            label="Username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            inputMode="text"
            placeholder="ama_mensah"
            maxLength={20}
            required
            disabled={busy}
            error={fieldErrors.username}
          />
          <Field
            label="PIN"
            name="pin"
            pin
            type={showPin ? "text" : "password"}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            autoComplete="current-password"
            required
            disabled={busy}
            error={fieldErrors.pin}
            help={
              <button type="button" className="k-link" style={{ minHeight: 32, fontSize: "var(--fs-sm)" }} onClick={() => setShowPin((s) => !s)}>
                {showPin ? "🙈 Hide PIN" : "👁 Show PIN"}
              </button>
            }
          />
          {error ? (
            <Banner tone="red" icon="⚠️">
              {error}
            </Banner>
          ) : null}
          <Button type="submit" size="big" loading={busy} disabled={!username || pin.length < 4}>
            🔓 Log in
          </Button>
        </form>
      </Card>

      <div className="flex flex-col items-center" style={{ gap: 2 }}>
        <Link href={next ? `/register?next=${encodeURIComponent(next)}` : "/register"} className="k-link">
          ✨ Create account
        </Link>
        <p style={{ color: "var(--hint)", fontSize: "var(--fs-sm)", textAlign: "center", margin: 0, padding: "0 8px" }}>
          Forgot your PIN? Ask the hostel office to reset it
          {tel ? (
            <>
              {" · "}
              <a href={`tel:${tel}`}>📞 {enquiryPhone}</a>
            </>
          ) : (
            "."
          )}
        </p>
      </div>
    </>
  );
}
