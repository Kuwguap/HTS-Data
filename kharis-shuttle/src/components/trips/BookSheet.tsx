"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { Booking, PickupLocation, Trip } from "@/lib/db.types";
import { formatDayTime } from "@/lib/time";
import { directionShort, seatsLeft } from "@/lib/trips";
import { Art, Button, Checkbox, Field, List, Row, Sheet, useToast, type ButtonSize } from "@/components/ui";

export type BookSheetTrip = Pick<
  Trip,
  "id" | "departure_at" | "direction" | "seat_capacity" | "confirmed_count" | "waitlist_count" | "destination_label"
>;

export type BookSheetProps = {
  trip: BookSheetTrip;
  /** Active pickup points; filtered to the trip's direction here. */
  pickupLocations: PickupLocation[];
  /** "GH₵10" */
  fare: string;
  timeZone: string;
  /** Trigger button style: a small pill in a row, or the big primary button. */
  size?: "pill" | ButtonSize;
  /** Trigger label; defaults to "Book" / "Join waitlist". */
  label?: string;
  /** Server time in ms (keeps SSR and client in step). */
  nowMs?: number;
  className?: string;
};

type BookResponse = { booking: Booking; trip: Trip };

/**
 * "Reserve a seat" bottom sheet with its own trigger button: pickup point
 * radio list, optional note, fare line and the cash agreement.
 */
export function BookSheet({ trip, pickupLocations, fare, timeZone, size = "pill", label, nowMs, className }: BookSheetProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [cash, setCash] = useState(false);
  const [errors, setErrors] = useState<{ pickup?: string; cash?: string; note?: string }>({});

  const options = useMemo(
    () => pickupLocations.filter((l) => l.is_active && (l.direction === null || l.direction === trip.direction)),
    [pickupLocations, trip.direction],
  );
  const [pickupId, setPickupId] = useState<string | null>(null);
  const chosen = pickupId ?? options[0]?.id ?? null;

  const full = seatsLeft(trip) <= 0;
  const triggerLabel = label ?? (full ? "Join waitlist" : "Book");
  const when = formatDayTime(trip.departure_at, nowMs ? new Date(nowMs) : undefined, timeZone);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setErrors({});
  };

  const submit = async () => {
    const next: typeof errors = {};
    if (options.length > 0 && !chosen) next.pickup = "Pick where you'll wait for the bus.";
    if (!cash) next.cash = "Please agree to pay the driver in cash.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const res = await api.post<BookResponse>("/api/bookings", {
        trip_id: trip.id,
        pickup_location_id: chosen,
        pickup_note: note.trim() || null,
        agreed_cash: true,
      });
      if (res.booking.status === "waitlisted") {
        toast(`⏳ You're #${res.booking.waitlist_position ?? "?"} on the waitlist`, { tone: "amber" });
      } else {
        toast("✅ Seat reserved", { tone: "green" });
      }
      setOpen(false);
      setNote("");
      setCash(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        switch (err.code) {
          case "ALREADY_BOOKED":
            toast("ℹ️ You already have a seat on this departure", { tone: "amber" });
            setOpen(false);
            router.refresh();
            return;
          case "BOOKING_CLOSED":
            toast("⏰ Booking has closed for this departure", { tone: "red" });
            setOpen(false);
            router.refresh();
            return;
          case "TRIP_NOT_OPEN":
            toast("🚫 This departure isn't open for booking", { tone: "red" });
            setOpen(false);
            router.refresh();
            return;
          case "PICKUP_INVALID":
            setErrors({ pickup: err.message });
            return;
          case "VALIDATION":
            setErrors({
              pickup: err.fieldError("pickup_location_id"),
              cash: err.fieldError("agreed_cash"),
              note: err.fieldError("pickup_note"),
            });
            return;
          default:
            toast(`⚠️ ${err.message || "Could not book — try again"}`, { tone: "red" });
            return;
        }
      }
      toast(`⚠️ ${errorMessage(err, "Could not book — try again")}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {size === "pill" ? (
        <Button pill size="sm" variant={full ? "secondary" : "primary"} onClick={() => setOpen(true)} className={className}>
          {triggerLabel}
        </Button>
      ) : (
        <Button size={size} onClick={() => setOpen(true)} className={className}>
          {full ? "⏳ Join the waitlist" : "🎟️ Reserve my seat"}
        </Button>
      )}

      <Sheet
        open={open}
        onClose={close}
        title={full ? "Join the waitlist" : "Reserve a seat"}
        footer={
          <Button size="big" onClick={submit} loading={busy} disabled={busy}>
            {full ? "⏳ Join the waitlist" : "🎟️ Reserve my seat"}
          </Button>
        }
      >
        <List>
          <Row label="Departure" value={when} />
          <Row label="Direction" value={directionShort(trip.direction)} />
          <Row label="Fare" value={`${fare} · cash only`} />
        </List>

        {full ? (
          <p className="k-banner" style={{ margin: 0 }}>
            <span aria-hidden="true">⏳</span>
            <span>
              {`All ${trip.seat_capacity} seats are taken. ${trip.waitlist_count} waiting — you'll be told if a seat opens up.`}
            </span>
          </p>
        ) : null}

        {options.length > 0 ? (
          <div>
            <div className="k-caption" style={{ paddingTop: 4 }}>
              Where will you wait?
            </div>
            <div className="k-list" role="radiogroup" aria-label="Pickup point">
              {options.map((loc) => (
                <Row
                  key={loc.id}
                  selected={chosen === loc.id}
                  onClick={() => {
                    setPickupId(loc.id);
                    setErrors((e) => ({ ...e, pickup: undefined }));
                  }}
                  leading={<Art k="pin" size={28} />}
                  title={loc.name}
                  subtitle={loc.description ?? undefined}
                  trailing={
                    <span className={["k-check", chosen === loc.id ? "k-check--on" : ""].join(" ").trim()} aria-hidden="true">
                      {chosen === loc.id ? (
                        <svg width="14" height="14" viewBox="0 0 14 14">
                          <path d="M2.5 7.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </div>
            {errors.pickup ? (
              <div className="k-error" role="alert">
                {errors.pickup}
              </div>
            ) : null}
          </div>
        ) : null}

        <Field
          as="textarea"
          label="Note for the driver (optional)"
          placeholder="I'll be at the gate with a suitcase"
          value={note}
          maxLength={140}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />

        <div>
          <Checkbox
            checked={cash}
            onChange={(v) => {
              setCash(v);
              if (v) setErrors((e) => ({ ...e, cash: undefined }));
            }}
            label={`I'll pay the driver ${fare} in cash`}
            hint="No mobile money yet — have the exact fare ready."
          />
          {errors.cash ? (
            <div className="k-error" role="alert">
              {errors.cash}
            </div>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
