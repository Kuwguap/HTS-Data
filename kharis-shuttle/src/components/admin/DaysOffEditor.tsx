"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Art, Button, Empty, Field, List, Pill, Row, Sheet, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatShortDate } from "@/lib/time";

type DayOff = { service_date: string; reason: string | null };
type Props = { daysOff: DayOff[]; today: string; timeZone: string };

type AddResponse = { trips_deleted: number; trips_cancelled: number; riders_notified: number };
type RemoveResponse = { trips_restored: number; trips_deleted: number; riders_notified: number };

export function DaysOffEditor({ daysOff, today, timeZone }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const upcoming = daysOff.filter((d) => d.service_date >= today).sort((a, b) => a.service_date.localeCompare(b.service_date));
  const past = daysOff.filter((d) => d.service_date < today);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await api.post<AddResponse>("/api/admin/days-off", { service_date: date, reason: reason || null });
      const extra = res.trips_cancelled ? ` · ${res.trips_cancelled} trip${res.trips_cancelled === 1 ? "" : "s"} cancelled, ${res.riders_notified} riders told` : "";
      toast(`✅ Day off added${extra}`, { tone: "green" });
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setErrors({ service_date: err.fieldError("service_date"), reason: err.fieldError("reason") });
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: DayOff) {
    if (
      !window.confirm(
        `Resume service on ${formatShortDate(d.service_date + "T12:00:00Z", timeZone)}? Trips cancelled for the day off are put back on (riders get a push); the next tick recreates the rest.`,
      )
    )
      return;
    setRemoving(d.service_date);
    try {
      const res = await api.delete<RemoveResponse>(`/api/admin/days-off/${d.service_date}`);
      const extra = res.trips_restored ? ` · ${res.trips_restored} trip${res.trips_restored === 1 ? "" : "s"} back on, ${res.riders_notified} riders told` : "";
      toast(`✅ Service resumed${extra}`, { tone: "green" });
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setRemoving(null);
    }
  }

  const rows = (items: DayOff[], removable: boolean) =>
    items.map((d) => (
      <Row
        key={d.service_date}
        leading={<Art k="calendar" size={32} />}
        title={formatShortDate(d.service_date + "T12:00:00Z", timeZone)}
        subtitle={d.reason ?? "No service"}
        trailing={
          removable ? (
            <Button variant="dangerSoft" size="sm" pill loading={removing === d.service_date} onClick={() => remove(d)}>
              Remove
            </Button>
          ) : (
            <Pill sm>Past</Pill>
          )
        }
        chevron={false}
      />
    ));

  return (
    <>
      <List caption="Upcoming days off">
        {upcoming.length === 0 ? <Empty art="calendar" title="No days off planned" hint="Shuttles run on every scheduled day." /> : rows(upcoming, true)}
      </List>
      <Button size="big" onClick={() => setOpen(true)}>
        ➕ Add day off
      </Button>
      {past.length > 0 ? <List caption="Past">{rows(past.slice(0, 20), false)}</List> : null}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Add a day off"
        footer={
          <Button size="big" type="submit" form="dayoff-form" loading={busy}>
            ✅ No shuttle that day
          </Button>
        }
      >
        <form id="dayoff-form" onSubmit={add} className="flex flex-col gap-4">
          <Field label="Date" type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} error={errors.service_date} required />
          <Field label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} placeholder="Public holiday" maxLength={120} />
          <p className="k-help">Trips already created for that day are removed; if anyone has booked, the trip is cancelled and riders get a push.</p>
        </form>
      </Sheet>
    </>
  );
}
