"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import type { Booking } from "@/lib/db.types";
import { Button, Sheet, useToast, type ButtonSize } from "@/components/ui";

export type CancelBookingButtonProps = {
  bookingId: string;
  /** "7:30 AM" — used in the confirmation copy. */
  tripLabel?: string;
  /** Waitlisted bookings get softer wording. */
  waitlisted?: boolean;
  size?: "pill" | ButtonSize;
  className?: string;
};

type CancelResponse = { cancelled: Booking; promoted: boolean };

/** "Cancel" button that confirms in a sheet, then POSTs /api/bookings/[id]/cancel. */
export function CancelBookingButton({ bookingId, tripLabel, waitlisted, size = "pill", className }: CancelBookingButtonProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post<CancelResponse>(`/api/bookings/${bookingId}/cancel`);
      toast(waitlisted ? "🗑 Left the waitlist" : "🗑 Seat cancelled");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not cancel — try again")}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  };

  const what = waitlisted ? "waitlist place" : "seat";
  const trigger =
    size === "pill" ? (
      <Button pill size="sm" variant="secondary" onClick={() => setOpen(true)} className={className}>
        Cancel
      </Button>
    ) : (
      <Button size={size} variant="dangerSoft" onClick={() => setOpen(true)} className={className}>
        🗑 Cancel my {what}
      </Button>
    );

  return (
    <>
      {trigger}
      <Sheet
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={`Cancel your ${what}?`}
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="danger" size="big" onClick={confirm} loading={busy}>
              🗑 Yes, cancel
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Keep it
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, color: "var(--text-2)" }}>
          {waitlisted
            ? `You'll leave the waitlist for the ${tripLabel ?? "selected"} shuttle. You can join again while booking is open.`
            : `Your seat on the ${tripLabel ?? "selected"} shuttle goes to the next person waiting. You can book again while seats are left.`}
        </p>
      </Sheet>
    </>
  );
}
