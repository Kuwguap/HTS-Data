"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Caption, Card, Field, List, Row, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { Settings } from "@/lib/db.types";
import { formatFare } from "@/lib/time";

type Driver = { id: string; full_name: string; role: string };
type Props = { settings: Settings; drivers: Driver[] };

const TIMEZONES = ["Africa/Accra", "Africa/Abidjan", "Africa/Lagos", "Africa/Nairobi", "Africa/Johannesburg", "Africa/Cairo", "UTC"];

type NumericKey =
  | "fare_cedis"
  | "default_seat_capacity"
  | "reminder_lead_minutes"
  | "nudge_minutes"
  | "manifest_lead_minutes"
  | "booking_cutoff_minutes"
  | "booking_open_days_ahead"
  | "location_stale_seconds";

type Form = {
  hostel_name: string;
  campus_name: string;
  timezone: string;
  fare_cedis: string;
  currency: string;
  payment_note: string;
  enquiry_phone: string;
  default_seat_capacity: string;
  reminder_lead_minutes: string;
  nudge_minutes: string;
  manifest_lead_minutes: string;
  booking_cutoff_minutes: string;
  booking_open_days_ahead: string;
  daily_announcement_enabled: boolean;
  daily_announcement_time: string;
  location_stale_seconds: string;
  signup_code: string;
  default_driver_id: string;
};

function toForm(s: Settings): Form {
  return {
    hostel_name: s.hostel_name,
    campus_name: s.campus_name,
    timezone: s.timezone,
    fare_cedis: String(s.fare_pesewas / 100),
    currency: s.currency,
    payment_note: s.payment_note,
    enquiry_phone: s.enquiry_phone ?? "",
    default_seat_capacity: String(s.default_seat_capacity),
    reminder_lead_minutes: String(s.reminder_lead_minutes),
    nudge_minutes: String(s.nudge_minutes),
    manifest_lead_minutes: String(s.manifest_lead_minutes),
    booking_cutoff_minutes: String(s.booking_cutoff_minutes),
    booking_open_days_ahead: String(s.booking_open_days_ahead),
    daily_announcement_enabled: s.daily_announcement_enabled,
    daily_announcement_time: s.daily_announcement_time.slice(0, 5),
    location_stale_seconds: String(s.location_stale_seconds),
    signup_code: s.signup_code ?? "",
    default_driver_id: s.default_driver_id ?? "",
  };
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function SettingsForm({ settings, drivers }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(() => toForm(settings));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const farePesewas = Math.round(Number(form.fare_cedis || 0) * 100);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = {
      hostel_name: form.hostel_name,
      campus_name: form.campus_name,
      timezone: form.timezone,
      fare_pesewas: farePesewas,
      currency: form.currency,
      payment_note: form.payment_note,
      enquiry_phone: form.enquiry_phone || null,
      default_seat_capacity: Number(form.default_seat_capacity),
      reminder_lead_minutes: Number(form.reminder_lead_minutes),
      nudge_minutes: Number(form.nudge_minutes),
      manifest_lead_minutes: Number(form.manifest_lead_minutes),
      booking_cutoff_minutes: Number(form.booking_cutoff_minutes),
      booking_open_days_ahead: Number(form.booking_open_days_ahead),
      daily_announcement_enabled: form.daily_announcement_enabled,
      daily_announcement_time: form.daily_announcement_time,
      location_stale_seconds: Number(form.location_stale_seconds),
      signup_code: form.signup_code || null,
      default_driver_id: form.default_driver_id || null,
    };
    try {
      const res = await api.put<{ settings: Settings }>("/api/admin/settings", body);
      setForm(toForm(res.settings));
      toast("✅ Settings saved", { tone: "green" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const next: Record<string, string | undefined> = {};
        for (const k of [...Object.keys(body), "fare_pesewas"]) next[k] = err.fieldError(k);
        if (next.fare_pesewas) next.fare_cedis = next.fare_pesewas;
        setErrors(next);
      }
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(form.signup_code);
      toast("📋 Join code copied");
    } catch {
      toast("⚠️ Could not copy", { tone: "red" });
    }
  };

  const numberField = (key: NumericKey, label: string, opts: { min?: number; max?: number; step?: string; help?: string } = {}) => (
    <Field
      label={label}
      type="number"
      inputMode="decimal"
      min={opts.min}
      max={opts.max}
      step={opts.step}
      value={form[key]}
      onChange={(e) => set(key, e.target.value)}
      error={errors[key]}
      help={opts.help}
      required
    />
  );

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <Caption>Hostel</Caption>
      <Card>
        <div className="flex flex-col gap-4">
          <Field label="Hostel name" value={form.hostel_name} onChange={(e) => set("hostel_name", e.target.value)} error={errors.hostel_name} maxLength={80} required />
          <Field label="Campus name" value={form.campus_name} onChange={(e) => set("campus_name", e.target.value)} error={errors.campus_name} maxLength={80} required help="Shown as the destination, e.g. KNUST." />
          <Field label="Enquiry phone" type="tel" inputMode="tel" value={form.enquiry_phone} onChange={(e) => set("enquiry_phone", e.target.value)} error={errors.enquiry_phone} placeholder="024 000 0000" maxLength={30} />
          <Field as="select" label="Timezone" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} error={errors.timezone}>
            {[...new Set([form.timezone, ...TIMEZONES])].map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Field>
        </div>
      </Card>

      <Caption>Fare</Caption>
      <Card>
        <div className="flex flex-col gap-4">
          {numberField("fare_cedis", `Fare (${formatFare(farePesewas, form.currency)})`, { min: 0, step: "0.5", help: "In cedis. Stored as pesewas." })}
          <Field label="Payment note" value={form.payment_note} onChange={(e) => set("payment_note", e.target.value)} error={errors.payment_note} maxLength={200} help="Shown when booking, e.g. cash only." />
        </div>
      </Card>

      <Caption>Seats &amp; bookings</Caption>
      <Card>
        <div className="flex flex-col gap-4">
          {numberField("default_seat_capacity", "Default seats per trip", { min: 1, max: 100 })}
          {numberField("booking_cutoff_minutes", "Booking closes (minutes before departure)", { min: 0, max: 120 })}
          {numberField("booking_open_days_ahead", "Days ahead students can book", { min: 0, max: 7, help: "0 = today only, 1 = today and tomorrow." })}
        </div>
      </Card>

      <Caption>Reminders</Caption>
      <Card>
        <div className="flex flex-col gap-4">
          {numberField("reminder_lead_minutes", "Trip reminder (minutes before)", { min: 5, max: 1440 })}
          {numberField("nudge_minutes", "Leaving-soon nudge (minutes before)", { min: 0, max: 120, help: "0 turns nudges off." })}
          {numberField("manifest_lead_minutes", "Driver manifest (minutes before)", { min: 0, max: 240 })}
          <List>
            <Row title="Daily announcement" subtitle="Morning push with the day's departures" trailing={<Switch checked={form.daily_announcement_enabled} onChange={(v) => set("daily_announcement_enabled", v)} label="Daily announcement" />} />
          </List>
          <Field label="Announcement time" type="time" value={form.daily_announcement_time} onChange={(e) => set("daily_announcement_time", e.target.value)} error={errors.daily_announcement_time} disabled={!form.daily_announcement_enabled} required />
        </div>
      </Card>

      <Caption>Tracking</Caption>
      <Card>{numberField("location_stale_seconds", "Bus counts as stale after (seconds)", { min: 15, max: 3600, help: "No GPS fix for this long hides the live marker." })}</Card>

      <Caption>Access</Caption>
      <Card>
        <div className="flex flex-col gap-4">
          <Field label="Hostel join code" value={form.signup_code} onChange={(e) => set("signup_code", e.target.value.toUpperCase())} error={errors.signup_code} placeholder="Empty = anyone can register" maxLength={40} autoComplete="off" />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" pill onClick={() => set("signup_code", randomCode())}>
              🎲 Generate
            </Button>
            <Button variant="secondary" size="sm" pill onClick={copyCode} disabled={!form.signup_code}>
              📋 Copy
            </Button>
            {form.signup_code ? (
              <Button variant="ghost" size="sm" pill onClick={() => set("signup_code", "")}>
                Clear
              </Button>
            ) : null}
          </div>
          <Field as="select" label="Default driver" value={form.default_driver_id} onChange={(e) => set("default_driver_id", e.target.value)} error={errors.default_driver_id} help="Gets the manifest when a trip has no driver assigned.">
            <option value="">None</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.full_name}
                {d.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </Field>
        </div>
      </Card>

      <Button size="big" type="submit" loading={busy}>
        ✅ Save settings
      </Button>
    </form>
  );
}
