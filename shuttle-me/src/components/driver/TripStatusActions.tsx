"use client";

import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { errorMessage, api } from "@/lib/api-client";
import type { Trip, TripStatus } from "@/lib/db.types";
import { Button, Field, Sheet, useToast } from "@/components/ui";

export type TripStatusActionsProps = {
  trip: Pick<Trip, "id" | "status" | "driver_id">;
  /** "hero": only the next-step button (white, for a gradient card). "full": next step + cancel. */
  variant?: "hero" | "full";
  /** Called with the new trip after a successful change (router.refresh() runs regardless). */
  onChanged?: (trip: Trip) => void;
  /** Runs before an "arrived" / "cancelled" transition (e.g. stop GPS sharing). */
  beforeFinish?: () => Promise<void> | void;
  className?: string;
};

type Step = { next: TripStatus & ("boarding" | "departed" | "arrived"); label: string; toast: string };

const NEXT_STEP: Partial<Record<TripStatus, Step>> = {
  scheduled: { next: "boarding", label: "🚏 Start boarding", toast: "🚏 Boarding started" },
  boarding: { next: "departed", label: "🚌 Depart", toast: "🚌 Departed — riders have been told" },
  departed: { next: "arrived", label: "🏁 Arrived", toast: "🏁 Trip finished" },
};

const onGradient: CSSProperties = { background: "rgba(255,255,255,0.94)", color: "var(--tone-green-ink)" };

/** Start boarding → Depart → Arrived buttons (+ cancel with reason) for one trip. */
export function TripStatusActions({ trip, variant = "full", onChanged, beforeFinish, className }: TripStatusActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"step" | "cancel" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();

  const step = NEXT_STEP[trip.status];
  const canCancel = trip.status === "scheduled" || trip.status === "boarding" || trip.status === "departed";

  const change = async (status: "boarding" | "departed" | "arrived" | "cancelled", extra?: { reason?: string }) => {
    setBusy(status === "cancelled" ? "cancel" : "step");
    try {
      if ((status === "arrived" || status === "cancelled") && beforeFinish) await beforeFinish();
      const { trip: updated } = await api.post<{ trip: Trip }>(`/api/driver/trips/${trip.id}/status`, { status, ...extra });
      toast(status === "cancelled" ? "🚫 Trip cancelled — riders have been told" : (step?.toast ?? "✅ Updated"), { tone: status === "cancelled" ? "amber" : "green" });
      setCancelOpen(false);
      setReason("");
      onChanged?.(updated);
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not update the trip — try again")}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  };

  if (!step && !canCancel) return null;

  if (variant === "hero") {
    if (!step) return null;
    return (
      <Button pill onClick={() => change(step.next)} loading={busy === "step"} style={onGradient} className={className}>
        {step.label}
      </Button>
    );
  }

  return (
    <div className={["flex flex-col gap-2", className ?? ""].join(" ").trim()}>
      {step ? (
        <Button size="big" onClick={() => change(step.next)} loading={busy === "step"} disabled={busy !== null}>
          {step.label}
        </Button>
      ) : null}
      {canCancel ? (
        <Button variant="dangerSoft" onClick={() => setCancelOpen(true)} disabled={busy !== null}>
          🚫 Cancel this trip
        </Button>
      ) : null}

      <Sheet
        open={cancelOpen}
        onClose={() => (busy ? undefined : setCancelOpen(false))}
        title="Cancel this trip?"
        footer={
          <div className="flex flex-col gap-2">
            <Button
              variant="danger"
              size="big"
              loading={busy === "cancel"}
              onClick={() => {
                const r = reason.trim();
                if (r.length > 200) {
                  setReasonError("Keep it under 200 characters.");
                  return;
                }
                setReasonError(undefined);
                void change("cancelled", { reason: r || undefined });
              }}
            >
              🚫 Cancel trip and tell riders
            </Button>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy !== null}>
              Keep the trip
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, color: "var(--hint)", fontSize: "var(--fs-md)" }}>
          Everyone with a seat or on the waitlist gets a push with your reason.
        </p>
        <Field
          as="textarea"
          label="Reason (optional)"
          placeholder="Bus broke down · heavy rain · no fuel"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          error={reasonError}
          disabled={busy !== null}
        />
      </Sheet>
    </div>
  );
}
