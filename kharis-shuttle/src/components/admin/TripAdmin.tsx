"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Avatar, Button, Empty, Field, List, Pill, Row, Sheet, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { BookingWithRider, TripWithDriver } from "@/lib/data/admin";
import type { Trip } from "@/lib/db.types";
import { formatDayLabel, formatDayTime, localDateString, zonedDateTime } from "@/lib/time";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, directionShort, isTripActive, TRIP_STATUS_LABEL, TRIP_STATUS_TONE } from "@/lib/trips";

type Driver = { id: string; full_name: string; role: string; phone: string | null };
type Props = { trip: TripWithDriver; bookings: BookingWithRider[]; drivers: Driver[]; timeZone: string };

type SheetKind = "seats" | "driver" | "time" | "cancel" | null;

export function TripAdmin({ trip, bookings, drivers, timeZone }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [seats, setSeats] = useState(String(trip.seat_capacity));
  const [driverId, setDriverId] = useState(trip.driver_id ?? "");
  const [date, setDate] = useState(localDateString(trip.departure_at, timeZone));
  const [time, setTime] = useState(() => {
    const d = new Date(trip.departure_at);
    const p = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const h = p.find((x) => x.type === "hour")?.value ?? "00";
    const m = p.find((x) => x.type === "minute")?.value ?? "00";
    return `${h === "24" ? "00" : h}:${m}`;
  });
  const [reason, setReason] = useState("");
  const editable = isTripActive(trip);
  // A schedule-linked trip owns its (schedule_time_id, service_date) slot: only the time can move.
  const dateLocked = trip.schedule_time_id != null;

  const close = () => {
    setSheet(null);
    setError(undefined);
  };

  async function patch(body: Record<string, unknown>, field: string, success: (res: { trip: Trip; promoted: number; notified: number }) => string) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.patch<{ trip: Trip; promoted: number; notified: number }>(`/api/admin/trips/${trip.id}`, body);
      toast(success(res), { tone: "green" });
      close();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.fieldError(field) ?? err.message);
      else setError(errorMessage(err));
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  const saveSeats = (e: FormEvent) => {
    e.preventDefault();
    void patch({ seat_capacity: Number(seats) }, "seat_capacity", (r) => (r.promoted ? `✅ ${r.trip.seat_capacity} seats · ${r.promoted} promoted from the waitlist` : `✅ ${r.trip.seat_capacity} seats`));
  };
  const saveDriver = (e: FormEvent) => {
    e.preventDefault();
    void patch({ driver_id: driverId || null }, "driver_id", () => (driverId ? "✅ Driver assigned" : "✅ Driver unassigned"));
  };
  const saveTime = (e: FormEvent) => {
    e.preventDefault();
    const departure_at = zonedDateTime(dateLocked ? localDateString(trip.departure_at, timeZone) : date, time, timeZone).toISOString();
    void patch({ departure_at }, "departure_at", (r) => `✅ Now leaves at ${formatDayTime(r.trip.departure_at, new Date(), timeZone)} · ${r.notified} riders told`);
  };
  const toggleBookings = (next: boolean) => void patch({ bookings_enabled: next }, "bookings_enabled", () => (next ? "✅ Bookings open" : "⏸ Bookings closed"));

  async function cancel(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.post<{ trip: Trip; notified: number }>(`/api/admin/trips/${trip.id}/cancel`, { reason });
      toast(`✅ Trip cancelled · ${res.notified} riders told`, { tone: "green" });
      close();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.fieldError("reason") ?? err.message);
      else setError(errorMessage(err));
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  const active = bookings.filter((b) => b.status !== "cancelled");
  const cancelled = bookings.filter((b) => b.status === "cancelled");

  return (
    <>
      <List caption="Trip">
        <Row label="Departure" value={formatDayTime(trip.departure_at, new Date(), timeZone)} onClick={editable ? () => setSheet("time") : undefined} chevron={editable} />
        <Row label="Route" value={`${trip.origin_label} → ${trip.destination_label}`} />
        <Row label="Direction" value={directionShort(trip.direction)} />
        <Row
          label="Status"
          value={
            <Pill tone={TRIP_STATUS_TONE[trip.status]} sm>
              {TRIP_STATUS_LABEL[trip.status]}
            </Pill>
          }
        />
        <Row label="Seats" value={`${trip.confirmed_count}/${trip.seat_capacity}${trip.waitlist_count ? ` · ${trip.waitlist_count} waiting` : ""}`} onClick={editable ? () => setSheet("seats") : undefined} chevron={editable} />
        <Row label="Driver" value={trip.driver_name ?? "Not assigned"} onClick={editable ? () => setSheet("driver") : undefined} chevron={editable} />
        <Row title="Bookings open" subtitle="Students can reserve seats" trailing={<Switch checked={trip.bookings_enabled} disabled={!editable || busy} onChange={toggleBookings} label="Bookings open" />} />
        {trip.cancel_reason ? <Row label="Reason" value={trip.cancel_reason} /> : null}
      </List>

      <div className="flex gap-2">
        <Button variant="secondary" href={`/driver/trips/${trip.id}`} className="flex-1">
          📋 Manifest view
        </Button>
        {editable ? (
          <Button variant="dangerSoft" onClick={() => setSheet("cancel")} className="flex-1">
            ❌ Cancel trip
          </Button>
        ) : null}
      </div>

      <List caption={`Bookings · ${active.length}`}>
        {active.length === 0 ? (
          <Empty art="seat" title="No bookings yet" hint="Riders appear here as they reserve seats." />
        ) : (
          active.map((b) => (
            <Row
              key={b.id}
              leading={<Avatar name={b.rider?.full_name ?? "?"} />}
              title={b.rider?.full_name ?? "Unknown rider"}
              subtitle={[b.pickup_name ?? "No pickup chosen", b.rider?.room ? `Room ${b.rider.room}` : null, b.pickup_note].filter(Boolean).join(" · ")}
              trailing={
                <>
                  {b.rider?.phone ? (
                    <a href={`tel:${b.rider.phone.replace(/\s+/g, "")}`} aria-label={`Call ${b.rider.full_name}`} style={{ fontSize: 20, minWidth: 32, textAlign: "center" }}>
                      📞
                    </a>
                  ) : null}
                  <Pill tone={BOOKING_STATUS_TONE[b.status]} sm>
                    {b.status === "waitlisted" && b.waitlist_position ? `Waitlist #${b.waitlist_position}` : BOOKING_STATUS_LABEL[b.status]}
                  </Pill>
                </>
              }
              chevron={false}
            />
          ))
        )}
      </List>
      {cancelled.length > 0 ? (
        <List caption={`Cancelled · ${cancelled.length}`}>
          {cancelled.map((b) => (
            <Row key={b.id} leading={<Avatar name={b.rider?.full_name ?? "?"} />} title={b.rider?.full_name ?? "Unknown rider"} subtitle={b.pickup_name ?? ""} trailing={<Pill sm>Cancelled</Pill>} chevron={false} />
          ))}
        </List>
      ) : null}

      <Sheet open={sheet === "seats"} onClose={close} title="Seats" footer={<Button size="big" type="submit" form="seats-form" loading={busy}>✅ Save seats</Button>}>
        <form id="seats-form" onSubmit={saveSeats} className="flex flex-col gap-3">
          <Field label="Seat capacity" type="number" inputMode="numeric" min={Math.max(1, trip.confirmed_count)} max={100} value={seats} onChange={(e) => setSeats(e.target.value)} error={error} help={trip.waitlist_count ? `${trip.waitlist_count} waiting — raising seats promotes them and sends a push.` : undefined} required />
        </form>
      </Sheet>

      <Sheet open={sheet === "driver"} onClose={close} title="Assign driver" footer={<Button size="big" type="submit" form="driver-form" loading={busy}>✅ Save driver</Button>}>
        <form id="driver-form" onSubmit={saveDriver} className="flex flex-col gap-3">
          <Field as="select" label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} error={error}>
            <option value="">Not assigned</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.full_name}
                {d.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </Field>
          <p className="k-help">The assigned driver gets the manifest push before departure.</p>
        </form>
      </Sheet>

      <Sheet open={sheet === "time"} onClose={close} title="Change departure" footer={<Button size="big" type="submit" form="time-form" loading={busy}>🔄 Update time</Button>}>
        <form id="time-form" onSubmit={saveTime} className="flex flex-col gap-3">
          {dateLocked ? (
            <Field label={`Leaves at · ${formatDayLabel(trip.departure_at, new Date(), timeZone)}`} type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          ) : (
            <div className="k-grid-2">
              <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              <Field label="Leaves at" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </div>
          )}
          {error ? <div className="k-error">{error}</div> : null}
          <p className="k-help">
            Booked riders and the driver get a &ldquo;Shuttle updated&rdquo; push with the new time.
            {dateLocked ? " This departure comes from the schedule, so it stays on its day — add an extra trip for another day." : ""}
          </p>
        </form>
      </Sheet>

      <Sheet open={sheet === "cancel"} onClose={close} title="Cancel this trip" footer={<Button size="big" variant="danger" type="submit" form="cancel-form" loading={busy}>❌ Cancel trip</Button>}>
        <form id="cancel-form" onSubmit={cancel} className="flex flex-col gap-3">
          <Field as="textarea" label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={error} placeholder="Bus is in the workshop" maxLength={200} required />
          <p className="k-help">{active.length} rider{active.length === 1 ? "" : "s"} will get a push with this reason.</p>
        </form>
      </Sheet>
    </>
  );
}
