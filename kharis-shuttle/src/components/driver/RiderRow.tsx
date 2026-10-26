"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import type { Booking, BookingStatus } from "@/lib/db.types";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE } from "@/lib/trips";
import type { ManifestBooking } from "@/lib/data/driver";
import { Avatar, Button, Pill, Row, useToast } from "@/components/ui";

export type RiderRowProps = {
  tripId: string;
  booking: ManifestBooking;
  /** Waitlist rows show the position and no board/no-show buttons. */
  waitlist?: boolean;
  /** Hide the action buttons (trip finished). */
  readOnly?: boolean;
};

function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** One manifest line: avatar, name, room · phone (tap to call), status pill, On board / No show. */
export function RiderRow({ tripId, booking, waitlist, readOnly }: RiderRowProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<BookingStatus | null>(null);
  const [status, setStatus] = useState<BookingStatus>(booking.status);

  const set = async (next: BookingStatus) => {
    const prev = status;
    setBusy(next);
    setStatus(next); // optimistic: a tap on a moving bus must feel instant
    try {
      const { booking: updated } = await api.post<{ booking: Booking }>(`/api/driver/trips/${tripId}/bookings/${booking.id}`, { status: next });
      setStatus(updated.status);
      toast(next === "boarded" ? `✅ ${booking.rider.full_name} is on board` : next === "no_show" ? `🙈 ${booking.rider.full_name} marked no-show` : `↩️ ${booking.rider.full_name} back to confirmed`, {
        tone: next === "no_show" ? "amber" : "green",
      });
      router.refresh();
    } catch (err) {
      setStatus(prev);
      toast(`⚠️ ${errorMessage(err, "Could not update — try again")}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  };

  const r = booking.rider;
  const subtitle = (
    <>
      {r.room ? `Room ${r.room}` : "No room"}
      {r.phone ? (
        <>
          {" · "}
          <a href={phoneHref(r.phone)} aria-label={`Call ${r.full_name}`} style={{ fontWeight: 600 }}>
            📞 {r.phone}
          </a>
        </>
      ) : null}
      {booking.pickup_note ? <span style={{ display: "block" }}>“{booking.pickup_note}”</span> : null}
    </>
  );

  const pill = waitlist ? (
    <Pill tone="amber" sm>
      ⏳ Waitlist #{booking.waitlist_position ?? "–"}
    </Pill>
  ) : (
    <Pill tone={BOOKING_STATUS_TONE[status]} sm>
      {status === "boarded" ? "✅ " : status === "no_show" ? "🙈 " : ""}
      {BOOKING_STATUS_LABEL[status]}
    </Pill>
  );

  const actions =
    readOnly || waitlist ? null : status === "confirmed" ? (
      <div className="flex gap-1">
        <Button pill size="sm" loading={busy === "boarded"} disabled={busy !== null} onClick={() => set("boarded")}>
          On board
        </Button>
        <Button pill size="sm" variant="secondary" loading={busy === "no_show"} disabled={busy !== null} onClick={() => set("no_show")}>
          No show
        </Button>
      </div>
    ) : (
      <div className="flex gap-1">
        {status === "no_show" ? (
          <Button pill size="sm" loading={busy === "boarded"} disabled={busy !== null} onClick={() => set("boarded")}>
            On board
          </Button>
        ) : null}
        <Button pill size="sm" variant="ghost" loading={busy === "confirmed"} disabled={busy !== null} onClick={() => set("confirmed")}>
          Undo
        </Button>
      </div>
    );

  return (
    <Row
      leading={<Avatar name={r.full_name} />}
      title={r.full_name}
      subtitle={subtitle}
      trailing={
        <div className="flex flex-col items-end gap-1" style={{ flex: "0 0 auto" }}>
          {pill}
          {actions}
        </div>
      }
      chevron={false}
    />
  );
}
