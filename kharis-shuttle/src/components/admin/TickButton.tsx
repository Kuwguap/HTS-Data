"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";

type TickResponse = { push: { claimed: number; sent: number; failed: number; skipped: number }; tick: { trips_created: number } | null };

/** "▶️ Run tick now" → POST /api/admin/tick. */
export function TickButton({ variant = "secondary" }: { variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api.post<TickResponse>("/api/admin/tick");
          toast(`✅ Tick ran · ${res.tick?.trips_created ?? 0} trips created · ${res.push.sent} pushed`, { tone: "green" });
          router.refresh();
        } catch (err) {
          toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
        } finally {
          setBusy(false);
        }
      }}
    >
      ▶️ Run tick now
    </Button>
  );
}
