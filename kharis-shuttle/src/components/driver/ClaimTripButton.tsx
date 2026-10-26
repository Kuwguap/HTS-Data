"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { Button, useToast, type ButtonSize } from "@/components/ui";

export type ClaimTripButtonProps = {
  tripId: string;
  size?: ButtonSize;
  pill?: boolean;
  className?: string;
};

/** "🙋 I'm driving this" → POST /api/driver/trips/[id]/claim. */
export function ClaimTripButton({ tripId, size = "sm", pill = true, className }: ClaimTripButtonProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      pill={pill}
      loading={busy}
      className={className}
      onClick={async () => {
        setBusy(true);
        try {
          await api.post(`/api/driver/trips/${tripId}/claim`);
          toast("🙋 You're driving this trip", { tone: "green" });
          router.refresh();
        } catch (err) {
          toast(`⚠️ ${errorMessage(err, "Could not claim the trip — try again")}`, { tone: "red" });
        } finally {
          setBusy(false);
        }
      }}
    >
      🙋 I&apos;m driving this
    </Button>
  );
}
