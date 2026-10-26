"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import type { PickupRequest } from "@/lib/db.types";
import { formatAgo, formatTime } from "@/lib/time";
import { PICKUP_STATUS_LABEL, PICKUP_STATUS_TONE, directionShort } from "@/lib/trips";
import type { RequestWithRider } from "@/lib/data/driver";
import { Avatar, Button, Card, Field, Pill, Sheet, useToast } from "@/components/ui";

export type RequestCardProps = {
  request: RequestWithRider;
  timezone: string;
  /** Called after accept / decline / picked-up succeeded (router.refresh() runs regardless). */
  onDone?: (request: PickupRequest) => void;
  /** Compact: no card chrome (used inside the tracking Sheet). */
  bare?: boolean;
};

function mapsHref(r: Pick<PickupRequest, "lat" | "lng" | "custom_place">): string | null {
  if (r.lat != null && r.lng != null) return `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`;
  if (r.custom_place) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.custom_place)}`;
  return null;
}

function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** Accept / Decline (with optional note) controls for a pending request. */
export function RespondControls({ request, onDone }: { request: RequestWithRider; onDone?: (r: PickupRequest) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [note, setNote] = useState("");

  const respond = async (action: "accept" | "decline") => {
    setBusy(action);
    try {
      const { request: updated } = await api.post<{ request: PickupRequest }>(`/api/pickup-requests/${request.id}/respond`, {
        action,
        note: note.trim() || undefined,
      });
      toast(action === "accept" ? `✅ Accepted — ${request.rider.full_name} will wait at ${request.pickup_name}` : `❌ Declined — ${request.rider.full_name} has been told`, {
        tone: action === "accept" ? "green" : "amber",
      });
      setDeclineOpen(false);
      setAcceptOpen(false);
      setNote("");
      onDone?.(updated);
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not send your answer — try again")}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <Button loading={busy === "accept"} disabled={busy !== null} onClick={() => respond("accept")}>
          ✅ Accept
        </Button>
        <Button variant="dangerSoft" loading={busy === "decline"} disabled={busy !== null} onClick={() => setDeclineOpen(true)}>
          ❌ Decline
        </Button>
      </div>
      <button type="button" className="k-link" style={{ fontSize: "var(--fs-sm)", minHeight: 32, alignSelf: "center" }} onClick={() => setAcceptOpen(true)} disabled={busy !== null}>
        ✅ Accept with a note
      </button>

      <Sheet
        open={acceptOpen}
        onClose={() => (busy ? undefined : setAcceptOpen(false))}
        title="Accept with a note"
        footer={
          <Button size="big" loading={busy === "accept"} onClick={() => respond("accept")}>
            ✅ Accept and send
          </Button>
        }
      >
        <Field as="textarea" label="Note to the rider (optional)" placeholder="Be at the gate in 5 min" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </Sheet>

      <Sheet
        open={declineOpen}
        onClose={() => (busy ? undefined : setDeclineOpen(false))}
        title="Decline this pickup?"
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="danger" size="big" loading={busy === "decline"} onClick={() => respond("decline")}>
              ❌ Decline and tell them
            </Button>
            <Button variant="ghost" onClick={() => setDeclineOpen(false)} disabled={busy !== null}>
              Back
            </Button>
          </div>
        }
      >
        <Field as="textarea" label="Reason (optional)" placeholder="Bus is full · not on my route" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </Sheet>
    </>
  );
}

/** "✅ Picked up" for an accepted request. */
export function CompleteButton({ request, onDone }: { request: RequestWithRider; onDone?: (r: PickupRequest) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { request: updated } = await api.post<{ request: PickupRequest }>(`/api/pickup-requests/${request.id}/complete`);
          toast(`✅ ${request.rider.full_name} picked up`, { tone: "green" });
          onDone?.(updated);
          router.refresh();
        } catch (err) {
          toast(`⚠️ ${errorMessage(err, "Could not update — try again")}`, { tone: "red" });
        } finally {
          setBusy(false);
        }
      }}
    >
      ✅ Picked up
    </Button>
  );
}

/** A pickup request: who, where (maps link), note, how long ago, which trip, and the actions for its status. */
export function RequestCard({ request, timezone, onDone, bare }: RequestCardProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const r = request.rider;
  const maps = mapsHref(request);
  const tripLine = request.trip ? `${formatTime(request.trip.departure_at, timezone)} · ${directionShort(request.trip.direction)}` : directionShort(request.direction);

  const body = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar name={r.full_name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-lg)", fontWeight: 700 }}>{r.full_name}</div>
          <div style={{ color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
            {r.room ? `Room ${r.room}` : "No room"}
            {r.phone ? (
              <>
                {" · "}
                <a href={phoneHref(r.phone)} style={{ fontWeight: 600 }} aria-label={`Call ${r.full_name}`}>
                  📞 {r.phone}
                </a>
              </>
            ) : null}
          </div>
        </div>
        <Pill tone={PICKUP_STATUS_TONE[request.status]} sm>
          {PICKUP_STATUS_LABEL[request.status]}
        </Pill>
      </div>

      <div className="k-list" style={{ boxShadow: "none", background: "var(--surface-2)" }}>
        <div className="k-row" style={{ minHeight: 48 }}>
          <span className="k-row-label">Place</span>
          <span className="k-row-value">
            {maps ? (
              <a href={maps} target="_blank" rel="noopener noreferrer">
                📍 {request.pickup_name} ↗
              </a>
            ) : (
              `📍 ${request.pickup_name}`
            )}
          </span>
        </div>
        <div className="k-row" style={{ minHeight: 48 }}>
          <span className="k-row-label">Trip</span>
          <span className="k-row-value">{tripLine}</span>
        </div>
        <div className="k-row" style={{ minHeight: 48 }}>
          <span className="k-row-label">Asked</span>
          <span className="k-row-value">{formatAgo(request.created_at)}</span>
        </div>
        {request.note ? (
          <div className="k-row" style={{ minHeight: 48 }}>
            <span className="k-row-label">Note</span>
            <span className="k-row-value">“{request.note}”</span>
          </div>
        ) : null}
        {request.response_note ? (
          <div className="k-row" style={{ minHeight: 48 }}>
            <span className="k-row-label">Your note</span>
            <span className="k-row-value">“{request.response_note}”</span>
          </div>
        ) : null}
      </div>

      {request.status === "pending" ? <RespondControls request={request} onDone={onDone} /> : null}
      {request.status === "accepted" ? <CompleteButton request={request} onDone={onDone} /> : null}
    </div>
  );

  return bare ? body : <Card>{body}</Card>;
}
