"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api } from "@/lib/api-client";
import type { PickupLocation, PickupRequest, Trip } from "@/lib/db.types";
import { formatAgo, formatTime } from "@/lib/time";
import { TRIP_LOCATION_UPDATE_COLUMNS } from "@/lib/tracking/columns";
import { TRIP_STATUS_LABEL, TRIP_STATUS_TONE, directionLabel } from "@/lib/trips";
import { createClient } from "@/lib/supabase/client";
import { useDriverTracking } from "@/hooks/useDriverTracking";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import type { RequestWithRider } from "@/lib/data/driver";
import LiveTripMapLoader from "@/components/map/LiveTripMapLoader";
import { tripDestination } from "@/lib/trips/endpoints";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { Banner, Button, Caption, Card, LiveChip, Pill, Sheet, StatTile, useToast } from "@/components/ui";
import { RequestCard } from "./RequestCard";
import { TripStatusActions } from "./TripStatusActions";

export type TrackingPanelProps = {
  trip: Trip;
  pickupLocations: PickupLocation[];
  settings: {
    timezone: string;
    location_stale_seconds: number;
    hostel_name: string;
    campus_name: string;
    hostel_lat?: number | null;
    hostel_lng?: number | null;
    campus_lat?: number | null;
    campus_lng?: number | null;
  };
};

const STATUS_COPY = {
  idle: { title: "Ready", hint: "Tap below to share the bus position with riders." },
  tracking: { title: "Tracking", hint: "Keep this screen open — the phone stops GPS in the background." },
  paused: { title: "Paused", hint: "Come back to this screen to keep sharing." },
  stopped: { title: "Stopped", hint: "Riders no longer see the bus move." },
  error: { title: "Not sharing", hint: "Fix the problem below and try again." },
} as const;

/** The driver's live tracking screen: big status, start/stop, GPS stats, paused banner, map preview, incoming requests. */
export function TrackingPanel({ trip, pickupLocations, settings }: TrackingPanelProps) {
  const dest = tripDestination(
    trip,
    { hostel_lat: settings.hostel_lat ?? null, hostel_lng: settings.hostel_lng ?? null, campus_lat: settings.campus_lat ?? null, campus_lng: settings.campus_lng ?? null },
    pickupLocations,
  );
  const destination = dest ? { ...dest, name: trip.direction === "to_campus" ? settings.campus_name : settings.hostel_name } : null;
  const router = useRouter();
  const { toast } = useToast();
  const tracking = useDriverTracking(trip.id);
  const [now, setNow] = useState(() => Date.now());
  const [queue, setQueue] = useState<RequestWithRider[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const canRun = trip.status === "boarding" || trip.status === "departed";
  const finished = trip.status === "arrived" || trip.status === "cancelled" || trip.status === "expired";

  // Keep the trip row fresh (status changed from elsewhere, e.g. the manifest page or admin).
  // The map preview follows last_* on its own, so our own GPS fixes must not refresh the page.
  useRealtimeInvalidate({ table: "trips", filter: `id=eq.${trip.id}`, event: "UPDATE", ignoreColumns: TRIP_LOCATION_UPDATE_COLUMNS });

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Auto-stop once the trip is over.
  useEffect(() => {
    if (finished && (tracking.status === "tracking" || tracking.status === "paused")) void tracking.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  // Incoming pickup requests: realtime insert → fetch the decorated pending list → queue the new ones.
  const loadPending = useCallback(async () => {
    try {
      const { pending } = await api.get<{ pending: RequestWithRider[] }>("/api/driver/requests");
      setQueue((prev) => {
        const ids = new Set(prev.map((r) => r.id));
        const fresh = pending.filter((r) => !ids.has(r.id) && !seen.current.has(r.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    } catch {
      // offline; the requests tab still lists them
    }
  }, []);

  useEffect(() => {
    void loadPending();
    let channel: RealtimeChannel | null = null;
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      return;
    }
    channel = supabase
      .channel(`driver-requests:${trip.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "pickup_requests" }, () => {
        void loadPending();
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(200);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pickup_requests" }, (payload) => {
        const row = payload.new as Partial<PickupRequest>;
        if (row.id && row.status && row.status !== "pending") setQueue((prev) => prev.filter((r) => r.id !== row.id));
      })
      .subscribe();
    return () => {
      if (channel) void supabase.removeChannel(channel);
    };
  }, [trip.id, loadPending]);

  const current = queue[0] ?? null;
  const dismissCurrent = () => {
    if (!current) return;
    seen.current.add(current.id);
    setQueue((prev) => prev.slice(1));
  };

  const copy = STATUS_COPY[tracking.status];
  const live = tracking.status === "tracking";
  const gps = tracking.accuracy == null ? "—" : tracking.accuracy <= 30 ? "Strong" : tracking.accuracy <= 100 ? "OK" : "Weak";
  const gpsLabel = tracking.accuracy == null ? "GPS · waiting" : `GPS · ±${Math.round(tracking.accuracy)} m`;
  const lastSent = tracking.lastSentAt ? formatAgo(tracking.lastSentAt, new Date(now)) : "never";

  const startSharing = () => {
    if (!canRun) {
      toast("⚠️ Start boarding first, then share your location", { tone: "amber" });
      return;
    }
    tracking.start();
    toast("📡 Sharing your location", { tone: "green" });
  };

  const stopSharing = async () => {
    await tracking.stop();
    toast("⏹ Stopped sharing");
  };

  return (
    <Page>
      <AppHeader
        back={`/driver/trips/${trip.id}`}
        greeting={`${formatTime(trip.departure_at, settings.timezone)} · ${directionLabel(trip.direction, settings)}`}
        title="Live tracking"
        right={<LiveChip live={live} label={live ? "Live" : tracking.status === "paused" ? "Paused" : "Off"} />}
      />

      {tracking.paused ? (
        <Banner tone="red" icon="⚠️" action={{ label: "Resume", onClick: tracking.resume }}>
          Tracking paused — keep this screen open while driving.
        </Banner>
      ) : null}

      {!canRun && !finished ? (
        <Banner tone="amber" icon="🚏">
          Start boarding before sharing your location.
        </Banner>
      ) : null}

      {finished ? (
        <Banner tone="blue" icon="🏁">
          This trip is {TRIP_STATUS_LABEL[trip.status].toLowerCase()}. Tracking is off.
        </Banner>
      ) : null}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="k-title" style={{ fontSize: 36, color: live ? "var(--tone-green-ink)" : tracking.status === "paused" ? "var(--tone-red-ink)" : "var(--text)" }}>
              {copy.title}
            </div>
            <p style={{ margin: "4px 0 0", color: "var(--hint)", fontSize: "var(--fs-md)" }}>{copy.hint}</p>
          </div>
          <Pill tone={TRIP_STATUS_TONE[trip.status]}>{TRIP_STATUS_LABEL[trip.status]}</Pill>
        </div>
        {tracking.status !== "idle" ? (
          <p style={{ margin: "8px 0 0", color: "var(--hint)", fontSize: "var(--fs-sm)" }} aria-live="polite">
            📡 Last sent {lastSent} · {tracking.sentCount} {tracking.sentCount === 1 ? "fix" : "fixes"}
            {tracking.queued > 0 ? ` · ${tracking.queued} queued` : ""}
          </p>
        ) : null}
        {tracking.error ? (
          <p className="k-error" style={{ marginTop: 10 }}>
            {tracking.error}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }} className="flex flex-col gap-2">
          {live || tracking.status === "paused" ? (
            <Button size="big" variant="dangerSoft" onClick={stopSharing}>
              ⏹ Stop sharing
            </Button>
          ) : (
            <Button size="big" onClick={startSharing} disabled={finished}>
              📡 Start sharing location
            </Button>
          )}
        </div>
      </Card>

      <div className="k-grid-2">
        <StatTile value={gps} label={gpsLabel} art="track" zero={tracking.accuracy == null} danger={tracking.accuracy != null && tracking.accuracy > 100} />
        <StatTile value={tracking.sentCount} label={tracking.queued > 0 ? `Points sent · ${tracking.queued} queued` : "Points sent"} art="pin" zero={tracking.sentCount === 0} />
        <StatTile value={lastSent} label="Last sent" art="clock" zero={!tracking.lastSentAt} />
        <StatTile
          value={tracking.wakeLock === "active" ? "On" : tracking.wakeLock === "released" ? "Off" : "n/a"}
          label="Keep screen awake"
          art="steering"
          zero={tracking.wakeLock !== "active"}
        />
      </div>

      <div>
        <Caption>Riders see this</Caption>
        <LiveTripMapLoader tripId={trip.id} initialTrip={trip} pickupLocations={pickupLocations} settings={settings} destination={destination} compact />
      </div>

      {!finished ? (
        <div>
          <Caption>Trip</Caption>
          <Card>
            <TripStatusActions
              trip={trip}
              beforeFinish={async () => {
                if (tracking.status === "tracking" || tracking.status === "paused") await tracking.stop();
              }}
              onChanged={() => router.refresh()}
            />
          </Card>
        </div>
      ) : null}

      <Sheet open={current !== null} onClose={dismissCurrent} title="✋ Pickup request">
        {current ? (
          <RequestCard
            request={current}
            timezone={settings.timezone}
            bare
            onDone={() => {
              seen.current.add(current.id);
              setQueue((prev) => prev.filter((r) => r.id !== current.id));
            }}
          />
        ) : null}
        {queue.length > 1 ? (
          <p style={{ margin: 0, color: "var(--hint)", fontSize: "var(--fs-sm)", textAlign: "center" }}>
            {queue.length - 1} more waiting
          </p>
        ) : null}
      </Sheet>
    </Page>
  );
}
