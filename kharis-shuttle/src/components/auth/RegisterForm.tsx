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
import { PIN_RE, USERNAME_RE, safeNextPath } from "@/lib/validation/common";

const USERNAME_HINT = "3–20 letters, numbers or _";

export type RegisterFormProps = {
  /** The admin set a hostel code: show the field. The code itself never reaches the browser. */
  requiresCode: boolean;
  hostelName: string;
  enquiryPhone?: string | null;
  /** In-app path to land on after onboarding (from /login?next=…). Re-validated here; unsafe values are dropped. */
  next?: string;
};

type RegisterResponse = { profile: PublicProfile; home: string };

type Errors = Partial<Record<"full_name" | "username" | "pin" | "pin_confirm" | "phone" | "room" | "signup_code", string>>;

export function RegisterForm({ requiresCode, hostelName, enquiryPhone, next: rawNext }: RegisterFormProps) {
  const router = useRouter();
  const next = safeNextPath(rawNext, "") || undefined;
  // The code field is hidden unless the page said a code is required — or the API
  // asked for one (the admin set a code after this page was rendered).
  const [codeVisible, setCodeVisible] = useState(requiresCode);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [phone, setPhone] = useState("");
  const [room, setRoom] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  const usernameOk = USERNAME_RE.test(username);
  const pinOk = PIN_RE.test(pin);
  const pinsMatch = pin === pinConfirm;

  const validate = (): Errors => {
    const next: Errors = {};
    if (fullName.trim().length < 2) next.full_name = "Enter your full name";
    if (!usernameOk) next.username = USERNAME_HINT;
    if (!pinOk) next.pin = "PIN must be 4–6 digits";
    if (!pinsMatch) next.pin_confirm = "PINs don't match";
    if (codeVisible && !signupCode.trim()) next.signup_code = "Enter the hostel code";
    return next;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const local = validate();
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    try {
      await api.post<RegisterResponse>("/api/auth/register", {
        username,
        full_name: fullName.trim(),
        pin,
        phone: phone.trim() || null,
        room: room.trim() || null,
        signup_code: codeVisible ? signupCode.trim() : null,
      });
      // /welcome forwards `next` once onboarding is done.
      router.replace(next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome");
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "USERNAME_TAKEN") {
          setErrors({ username: err.message });
        } else if (err.code === "SIGNUP_CODE") {
          if (codeVisible) {
            setErrors({ signup_code: err.message });
          } else {
            // The field was hidden, so an inline error would be invisible: explain in the banner and reveal it.
            setCodeVisible(true);
            setErrors({});
            setError(err.message);
          }
        } else if (err.code === "VALIDATION") {
          const next: Errors = {
            full_name: err.fieldError("full_name"),
            username: err.fieldError("username"),
            pin: err.fieldError("pin"),
            phone: err.fieldError("phone"),
            room: err.fieldError("room"),
            signup_code: err.fieldError("signup_code"),
          };
          setErrors(next);
          if (!Object.values(next).some(Boolean)) setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError("Something went wrong. Try again.");
      }
      setBusy(false);
    }
  };

  const tel = enquiryPhone ? enquiryPhone.replace(/\s+/g, "") : null;
  const pinType = showPin ? "text" : "password";

  return (
    <>
      <Card title="Create account">
        <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "-4px 0 12px" }}>
          For residents of {hostelName}. You only need a username and a PIN — no email.
        </p>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field
            label="Full name"
            name="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            autoCapitalize="words"
            placeholder="Ama Mensah"
            maxLength={80}
            required
            disabled={busy}
            error={errors.full_name}
          />
          <Field
            label="Username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ""))}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            placeholder="ama_mensah"
            maxLength={20}
            required
            disabled={busy}
            error={errors.username}
            help={username && !errors.username ? (usernameOk ? "✅ Looks good" : USERNAME_HINT) : USERNAME_HINT}
          />
          <Field
            label="PIN"
            name="pin"
            pin
            type={pinType}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            autoComplete="new-password"
            required
            disabled={busy}
            error={errors.pin}
            help="4–6 digits. You'll use it to log in."
          />
          <Field
            label="Confirm PIN"
            name="pin_confirm"
            pin
            type={pinType}
            value={pinConfirm}
            onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
            autoComplete="new-password"
            required
            disabled={busy}
            error={errors.pin_confirm ?? (pinConfirm && !pinsMatch ? "PINs don't match" : undefined)}
            help={
              <button type="button" className="k-link" style={{ minHeight: 32, fontSize: "var(--fs-sm)" }} onClick={() => setShowPin((s) => !s)}>
                {showPin ? "🙈 Hide PIN" : "👁 Show PIN"}
              </button>
            }
          />
          <Field
            label="Phone (optional)"
            name="phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            placeholder="024 000 0000"
            maxLength={30}
            disabled={busy}
            error={errors.phone}
            help="So the driver can reach you at the pickup point."
          />
          <Field
            label="Room (optional)"
            name="room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            autoCapitalize="characters"
            placeholder="B12"
            maxLength={20}
            disabled={busy}
            error={errors.room}
          />
          {requiresCode ? (
            <Field
              label="Hostel code"
              name="signup_code"
              value={signupCode}
              onChange={(e) => setSignupCode(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              placeholder="From the hostel office"
              maxLength={40}
              required
              disabled={busy}
              error={errors.signup_code}
              help={tel ? <>Don&apos;t have it? Call <a href={`tel:${tel}`}>{enquiryPhone}</a>.</> : "Ask the hostel office for it."}
            />
          ) : null}
          {error ? (
            <Banner tone="red" icon="⚠️">
              {error}
            </Banner>
          ) : null}
          <Button type="submit" size="big" loading={busy} disabled={!fullName.trim() || !username || !pin || !pinConfirm}>
            ✅ Create my account
          </Button>
        </form>
      </Card>
      <div className="flex justify-center">
        <Link href="/login" className="k-link">
          Already have an account? Log in
        </Link>
      </div>
    </>
  );
}
