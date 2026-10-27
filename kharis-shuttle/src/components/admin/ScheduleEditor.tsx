"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Empty, Field, List, Row, SegmentedControl, Sheet, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { ScheduleTime, TripDirection } from "@/lib/db.types";
import { formatClock, formatDays, WEEKDAY_SHORT } from "@/lib/time";

type Props = {
  schedule: ScheduleTime[];
  defaultCapacity: number;
  campusName: string;
  hostelName: string;
};

type Form = {
  direction: TripDirection;
  depart_time: string;
  days_of_week: number[];
  label: string;
  seat_capacity: string;
  bookings_enabled: boolean;
  is_active: boolean;
};

const EMPTY: Form = { direction: "to_campus", depart_time: "07:30", days_of_week: [1, 2, 3, 4, 5], label: "", seat_capacity: "", bookings_enabled: true, is_active: true };

/** PATCH / DELETE /api/admin/schedule/:id report how the already created trips were handled. */
type PropagationResult = { deleted_trips?: number; kept_with_bookings?: number };

export function keptTripsNote(kept: number | undefined): string | null {
  if (!kept || kept <= 0) return null;
  return `${kept} upcoming ${kept === 1 ? "trip" : "trips"} with bookings ${kept === 1 ? "keeps its" : "keep their"} old time — change ${kept === 1 ? "it" : "them"} under Trips`;
}

function toForm(s: ScheduleTime): Form {
  return {
    direction: s.direction,
    depart_time: s.depart_time.slice(0, 5),
    days_of_week: s.days_of_week,
    label: s.label ?? "",
    seat_capacity: s.seat_capacity == null ? "" : String(s.seat_capacity),
    bookings_enabled: s.bookings_enabled,
    is_active: s.is_active,
  };
}

/** Multi-select Mon..Sun pills. */
export function DayPills({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            className="k-filter"
            aria-pressed={on}
            style={{ padding: "0 12px", minHeight: 40 }}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b))}
          >
            {WEEKDAY_SHORT[d]}
          </button>
        );
      })}
    </div>
  );
}

export function ScheduleEditor({ schedule, defaultCapacity, campusName, hostelName }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<ScheduleTime | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  /** Inline note after the last change: trips that kept their old values because they have bookings. */
  const [keptNote, setKeptNote] = useState<string | null>(null);

  /** One toast (the provider shows one at a time): the success line, plus the kept-trips warning when there is one. */
  const report = (done: string, result: PropagationResult | undefined) => {
    const note = keptTripsNote(result?.kept_with_bookings);
    setKeptNote(note);
    if (note) toast(`${done} · ⚠️ ${note}`, { tone: "amber", ms: 7000, onTap: () => router.push("/admin/trips") });
    else toast(done, { tone: "green" });
  };

  const open = (s: ScheduleTime | "new") => {
    setEditing(s);
    setForm(s === "new" ? EMPTY : toForm(s));
    setErrors({});
  };
  const close = () => setEditing(null);

  const payload = () => ({
    direction: form.direction,
    depart_time: form.depart_time,
    days_of_week: form.days_of_week,
    label: form.label || null,
    seat_capacity: form.seat_capacity ? Number(form.seat_capacity) : null,
    bookings_enabled: form.bookings_enabled,
    is_active: form.is_active,
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (form.days_of_week.length === 0) {
      setErrors({ days_of_week: "Pick at least one day" });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      if (editing === "new") {
        await api.post("/api/admin/schedule", payload());
        report("✅ Departure added", undefined);
      } else if (editing) {
        const result = await api.patch<PropagationResult>(`/api/admin/schedule/${editing.id}`, payload());
        report("✅ Departure saved", result);
      }
      close();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({
          depart_time: err.fieldError("depart_time"),
          days_of_week: err.fieldError("days_of_week"),
          label: err.fieldError("label"),
          seat_capacity: err.fieldError("seat_capacity"),
        });
      }
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || editing === "new") return;
    if (!window.confirm(`Delete the ${formatClock(editing.depart_time)} departure? Upcoming trips without bookings are removed too; trips with bookings are kept.`)) return;
    setBusy(true);
    try {
      const result = await api.delete<PropagationResult>(`/api/admin/schedule/${editing.id}`);
      report("🗑 Departure deleted", result);
      close();
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(s: ScheduleTime, next: boolean) {
    setToggling(s.id);
    try {
      const result = await api.patch<PropagationResult>(`/api/admin/schedule/${s.id}`, { is_active: next });
      report(next ? "✅ Departure on" : "⏸ Departure paused", result);
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setToggling(null);
    }
  }

  const section = (direction: TripDirection, caption: string) => {
    const items = schedule.filter((s) => s.direction === direction);
    return (
      <List caption={caption}>
        {items.length === 0 ? (
          <Empty art="clock" title="No departures" hint="Add one below." />
        ) : (
          items.map((s) => (
            <Row
              key={s.id}
              title={`${formatClock(s.depart_time)}${s.label ? ` · ${s.label}` : ""}`}
              subtitle={`${formatDays(s.days_of_week)} · ${s.seat_capacity ?? defaultCapacity} seats${s.bookings_enabled ? "" : " · bookings off"}${s.is_active ? "" : " · paused"}`}
              trailing={
                <>
                  <Switch checked={s.is_active} disabled={toggling === s.id} onChange={(next) => toggleActive(s, next)} label={`${formatClock(s.depart_time)} active`} />
                  <Button variant="ghost" size="sm" onClick={() => open(s)} aria-label={`Edit ${formatClock(s.depart_time)}`}>
                    ✏️
                  </Button>
                </>
              }
              chevron={false}
            />
          ))
        )}
      </List>
    );
  };

  return (
    <>
      {section("to_campus", `To ${campusName}`)}
      {section("to_hostel", `To ${hostelName}`)}

      <Button size="big" onClick={() => open("new")}>
        ➕ Add departure
      </Button>
      {keptNote ? (
        <p className="k-help" role="status" style={{ textAlign: "center" }}>
          ⚠️ {keptNote}.{" "}
          <Link href="/admin/trips" className="k-link">
            Open Trips
          </Link>
        </p>
      ) : null}
      <p className="k-help" style={{ textAlign: "center" }}>
        Changes apply to trips created from now on. Upcoming trips that already have bookings keep their old time — change them under Trips.
      </p>

      <Sheet
        open={editing !== null}
        onClose={close}
        title={editing === "new" ? "New departure" : "Edit departure"}
        footer={
          <div className="flex flex-col gap-2">
            <Button size="big" type="submit" form="schedule-form" loading={busy}>
              {editing === "new" ? "➕ Add departure" : "✅ Save"}
            </Button>
            {editing && editing !== "new" ? (
              <Button variant="dangerSoft" onClick={remove} disabled={busy}>
                🗑 Delete departure
              </Button>
            ) : null}
          </div>
        }
      >
        <form id="schedule-form" onSubmit={save} className="flex flex-col gap-4">
          <div>
            <span className="k-label">Direction</span>
            <SegmentedControl
              aria-label="Direction"
              value={form.direction}
              onChange={(direction) => setForm({ ...form, direction })}
              options={[
                { value: "to_campus", label: "To campus" },
                { value: "to_hostel", label: "To hostel" },
              ]}
            />
          </div>
          <Field label="Departure time" type="time" value={form.depart_time} onChange={(e) => setForm({ ...form, depart_time: e.target.value })} error={errors.depart_time} required />
          <div>
            <span className="k-label">Days</span>
            <DayPills value={form.days_of_week} onChange={(days_of_week) => setForm({ ...form, days_of_week })} />
            {errors.days_of_week ? <div className="k-error">{errors.days_of_week}</div> : null}
          </div>
          <Field label="Label (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} error={errors.label} placeholder="Morning, Last return…" maxLength={60} />
          <Field
            label="Seats"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={form.seat_capacity}
            onChange={(e) => setForm({ ...form, seat_capacity: e.target.value })}
            error={errors.seat_capacity}
            placeholder={String(defaultCapacity)}
            help={`Leave empty to use the default (${defaultCapacity}).`}
          />
          <List>
            <Row title="Bookings enabled" subtitle="Students can reserve seats" trailing={<Switch checked={form.bookings_enabled} onChange={(bookings_enabled) => setForm({ ...form, bookings_enabled })} label="Bookings enabled" />} />
            <Row title="Active" subtitle="Creates trips on the chosen days" trailing={<Switch checked={form.is_active} onChange={(is_active) => setForm({ ...form, is_active })} label="Active" />} />
          </List>
        </form>
      </Sheet>
    </>
  );
}
