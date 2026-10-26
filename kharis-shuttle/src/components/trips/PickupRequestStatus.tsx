"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import type { PickupRequest } from "@/lib/db.types";
import { formatCountdown, formatDayTime, formatTime } from "@/lib/time";
import { PICKUP_STATUS_LABEL, PICKUP_STATUS_TONE, directionShort } from "@/lib/trips";
import { Banner, Button, Card, List, Pill, Row, Spinner, useToast } from "@/components/ui";

export type PickupRequestStatusProps = {
  initial: PickupRequest;
  pickupName: string | null;
  /** "7:30 AM" of the attached trip, when there is one. */
  tripTime?: string | null;
  tripId?: string | null;
  timeZone: string;
  /** Server time in ms for the first render (SSR and hydration agree on the countdown). */
  nowMs: number;
  pollMs?: number;
  /** How often the countdown / day labels re-render (default 15 s). */
  clockMs?: number;
};

const OPEN_STATES: ReadonlySet<PickupRequest["status"]> = new Set(["pending", "accepted"]);

/**
 * Status card for one pickup request. Polls GET /api/pickup-requests/[id]
 * every 10 s while the driver has not answered yet (and while accepted, so
 * "picked up" shows up), with a cancel button while that is still possible.
 */
export function PickupRequestStatus({ initial, pickupName, tripTime, tripId, timeZone, nowMs, pollMs = 10_000, clockMs = 15_000 }: PickupRequestStatusProps) {
  const router = useRouter();
  const { toast } = useToast();
  // The page keys this component by the row's updated_at, so a server refresh resets it.
  const [request, setRequest] = useState<PickupRequest>(initial);
  const [busy, setBusy] = useState(false);
  // Relative labels ("expires in 12 min", "Today") start from the server clock and tick on the client.
  const [now, setNow] = useState(() => new Date(nowMs));

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), clockMs);
    return () => window.clearInterval(id);
  }, [clockMs]);

  useEffect(() => {
    if (!OPEN_STATES.has(request.status)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get<{ request: PickupRequest }>(`/api/pickup-requests/${request.id}`);
        if (!cancelled && res.request) setRequest(res.request);
      } catch {
        // transient — the next poll will retry
      }
    };
    const id = window.setInterval(tick, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [request.id, request.status, pollMs]);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ request: PickupRequest }>(`/api/pickup-requests/${request.id}/cancel`);
      setRequest(res.request);
      toast("🗑 Request cancelled");
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not cancel — try again")}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  };

  const place = pickupName ?? request.custom_place ?? (request.lat != null && request.lng != null ? "My shared location" : "—");
  const status = request.status;
  const canCancel = OPEN_STATES.has(status);

  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Pickup request"
        action={
          <Pill tone={PICKUP_STATUS_TONE[status]}>
            {PICKUP_STATUS_LABEL[status]}
          </Pill>
        }
      >
        {status === "pending" ? (
          <div className="flex items-center gap-3" style={{ color: "var(--hint)" }}>
            <Spinner size={18} label="Waiting" />
            <span>Waiting for the driver to answer · expires {formatCountdown(request.expires_at, now)}</span>
          </div>
        ) : null}
        {status === "accepted" ? (
          <Banner tone="green" icon="✅">
            The driver is coming. Wait at {place} and have your fare ready.
          </Banner>
        ) : null}
        {status === "declined" ? (
          <Banner tone="red" icon="❌">
            {request.response_note ? request.response_note : "The driver can't pick you up this time."}
          </Banner>
        ) : null}
        {status === "expired" ? (
          <Banner tone="amber" icon="⌛">
            Nobody answered in time. Send a new request or call the hostel office.
          </Banner>
        ) : null}
        {status === "completed" ? (
          <Banner tone="blue" icon="🚌">
            Picked up — enjoy the ride.
          </Banner>
        ) : null}
        {status === "cancelled" ? (
          <Banner tone="amber" icon="🗑">
            You cancelled this request.
          </Banner>
        ) : null}
      </Card>

      <List caption="Details">
        <Row label="Place" value={place} />
        <Row label="Direction" value={directionShort(request.direction)} />
        {tripTime ? <Row label="Shuttle" value={tripTime} href={tripId ? `/app/trips/${tripId}` : undefined} /> : null}
        {request.note ? <Row label="Your note" value={request.note} /> : null}
        {request.response_note && status !== "declined" ? <Row label="Driver says" value={request.response_note} /> : null}
        <Row label="Sent" value={formatDayTime(request.created_at, now, timeZone)} />
        {request.responded_at ? <Row label="Answered" value={formatTime(request.responded_at, timeZone)} /> : null}
      </List>

      {canCancel ? (
        <Button variant="dangerSoft" onClick={cancel} loading={busy}>
          🗑 Cancel request
        </Button>
      ) : (
        <Button variant="secondary" href="/app/request">
          ✋ Send a new request
        </Button>
      )}
    </div>
  );
}
