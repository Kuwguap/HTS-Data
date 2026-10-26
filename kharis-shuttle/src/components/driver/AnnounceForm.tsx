"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { Trip, TripDirection } from "@/lib/db.types";
import { formatFare } from "@/lib/time";
import { Button, Caption, Card, Field, FilterPills, SegmentedControl, useToast } from "@/components/ui";

export type AnnounceFormProps = {
  settings: { hostel_name: string; campus_name: string; default_seat_capacity: number; fare_pesewas: number; currency: string };
  /** The admin-editable return_announcement template (title + body with {placeholders}). */
  template: { title: string; body: string };
};

type Leaving = "0" | "5" | "10" | "15";

function render(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ""));
}

/** "📣 Shuttle is at ___ heading to the hostel, leaving in N min" → POST /api/driver/announce → tracking screen. */
export function AnnounceForm({ settings, template }: AnnounceFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [origin, setOrigin] = useState(settings.campus_name);
  const [direction, setDirection] = useState<TripDirection>("to_hostel");
  const [leaving, setLeaving] = useState<Leaving>("10");
  const [seats, setSeats] = useState(String(settings.default_seat_capacity));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const destination = direction === "to_hostel" ? settings.hostel_name : settings.campus_name;
  const vars = {
    origin: origin.trim() || "…",
    hostel: settings.hostel_name,
    campus: settings.campus_name,
    destination,
    count: Number(leaving),
    fare: formatFare(settings.fare_pesewas, settings.currency),
    message: message.trim(),
    seats: Number(seats) || settings.default_seat_capacity,
  };

  const submit = async () => {
    const next: Record<string, string | undefined> = {};
    if (!origin.trim()) next.origin_label = "Where is the shuttle now?";
    const seatNum = Number(seats);
    if (!Number.isInteger(seatNum) || seatNum < 1 || seatNum > 100) next.seat_capacity = "Seats must be between 1 and 100.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setBusy(true);
    try {
      const { trip } = await api.post<{ trip: Trip }>("/api/driver/announce", {
        direction,
        origin_label: origin.trim(),
        leaving_in_minutes: Number(leaving),
        seat_capacity: seatNum,
        message: message.trim() || undefined,
      });
      toast("📣 Announced — students have been told", { tone: "green" });
      router.replace(`/driver/trips/${trip.id}/track`);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "VALIDATION") {
        setErrors({
          origin_label: err.fieldError("origin_label"),
          seat_capacity: err.fieldError("seat_capacity"),
          message: err.fieldError("message"),
        });
      }
      toast(`⚠️ ${errorMessage(err, "Could not announce — try again")}`, { tone: "red" });
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-col gap-4">
          <Field
            label="Shuttle is at"
            name="origin_label"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder={settings.campus_name}
            maxLength={60}
            autoComplete="off"
            error={errors.origin_label}
            disabled={busy}
          />
          <div>
            <span className="k-label">Heading</span>
            <SegmentedControl
              aria-label="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "to_hostel", label: `To ${settings.hostel_name}` },
                { value: "to_campus", label: `To ${settings.campus_name}` },
              ]}
            />
          </div>
          <div>
            <span className="k-label">Leaving in</span>
            <FilterPills
              aria-label="Leaving in minutes"
              value={leaving}
              onChange={setLeaving}
              options={[
                { value: "0", label: "Now" },
                { value: "5", label: "5 min" },
                { value: "10", label: "10 min" },
                { value: "15", label: "15 min" },
              ]}
            />
          </div>
          <Field
            label="Seats"
            name="seat_capacity"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            error={errors.seat_capacity}
            disabled={busy}
          />
          <Field
            as="textarea"
            label="Message (optional)"
            name="message"
            placeholder="Last trip tonight · bring exact change"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={200}
            error={errors.message}
            disabled={busy}
          />
        </div>
      </Card>

      <div>
        <Caption>Push preview</Caption>
        <div className="flex flex-col gap-2">
          <div className="k-bubble k-bubble--in" style={{ maxWidth: "100%" }}>
            <strong style={{ display: "block" }}>{render(template.title, vars)}</strong>
            {render(template.body, vars)}
            {vars.message ? <span style={{ display: "block", marginTop: 4 }}>{vars.message}</span> : null}
          </div>
          <p style={{ margin: "0 4px", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
            Goes to every student with reminders on. Tapping it opens the live map.
          </p>
        </div>
      </div>

      <Button size="big" onClick={submit} loading={busy}>
        📣 Announce and start tracking
      </Button>
    </div>
  );
}
