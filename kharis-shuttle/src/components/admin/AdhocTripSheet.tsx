"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Checkbox, Field, SegmentedControl, Sheet, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { Trip, TripDirection } from "@/lib/db.types";
import { zonedDateTime } from "@/lib/time";

type Driver = { id: string; full_name: string; role: string };
type Props = {
  date: string;
  timeZone: string;
  hostelName: string;
  campusName: string;
  defaultCapacity: number;
  drivers: Driver[];
  defaultDriverId: string | null;
};

/** "➕ Extra trip" button + sheet → POST /api/admin/trips (adhocTripSchema). */
export function AdhocTripSheet({ date, timeZone, hostelName, campusName, defaultCapacity, drivers, defaultDriverId }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<TripDirection>("to_campus");
  const [origin, setOrigin] = useState(hostelName);
  const [destination, setDestination] = useState(campusName);
  const [tripDate, setTripDate] = useState(date);
  const [time, setTime] = useState("");
  const [seats, setSeats] = useState("");
  const [driverId, setDriverId] = useState(defaultDriverId ?? "");
  const [notify, setNotify] = useState(true);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const pickDirection = (d: TripDirection) => {
    setDirection(d);
    setOrigin(d === "to_campus" ? hostelName : campusName);
    setDestination(d === "to_campus" ? campusName : hostelName);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!time) {
      setErrors({ departure_at: "Pick a departure time" });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const departure_at = zonedDateTime(tripDate, time, timeZone).toISOString();
      const res = await api.post<{ trip: Trip; notified: number }>("/api/admin/trips", {
        direction,
        origin_label: origin,
        destination_label: destination,
        departure_at,
        seat_capacity: seats ? Number(seats) : null,
        driver_id: driverId || null,
        notify,
      });
      toast(notify ? `✅ Trip added · ${res.notified} students told` : "✅ Trip added", { tone: "green" });
      setOpen(false);
      router.push(`/admin/trips/${res.trip.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({ origin_label: err.fieldError("origin_label"), destination_label: err.fieldError("destination_label"), departure_at: err.fieldError("departure_at"), seat_capacity: err.fieldError("seat_capacity"), driver_id: err.fieldError("driver_id") });
      }
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="big" onClick={() => setOpen(true)}>
        ➕ Extra trip
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Extra trip"
        footer={
          <Button size="big" type="submit" form="adhoc-form" loading={busy}>
            🚌 Add trip
          </Button>
        }
      >
        <form id="adhoc-form" onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <span className="k-label">Direction</span>
            <SegmentedControl
              aria-label="Direction"
              value={direction}
              onChange={pickDirection}
              options={[
                { value: "to_campus", label: "To campus" },
                { value: "to_hostel", label: "To hostel" },
              ]}
            />
          </div>
          <Field label="From" value={origin} onChange={(e) => setOrigin(e.target.value)} error={errors.origin_label} required maxLength={60} />
          <Field label="To" value={destination} onChange={(e) => setDestination(e.target.value)} error={errors.destination_label} required maxLength={60} />
          <div className="k-grid-2">
            <Field label="Date" type="date" value={tripDate} onChange={(e) => setTripDate(e.target.value)} required />
            <Field label="Leaves at" type="time" value={time} onChange={(e) => setTime(e.target.value)} error={errors.departure_at} required />
          </div>
          <Field label="Seats" type="number" inputMode="numeric" min={1} max={100} value={seats} onChange={(e) => setSeats(e.target.value)} error={errors.seat_capacity} placeholder={String(defaultCapacity)} />
          <Field as="select" label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} error={errors.driver_id}>
            <option value="">Not assigned yet</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.full_name}
                {d.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </Field>
          <Checkbox checked={notify} onChange={setNotify} label="Tell students now" hint="Pushes a reminder to everyone with reminders on." />
        </form>
      </Sheet>
    </>
  );
}
