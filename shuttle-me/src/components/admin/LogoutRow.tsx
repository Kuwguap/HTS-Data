"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Row, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { detachDeviceSubscription } from "@/lib/push/client";

/** "Log out" list row: detach this device's push endpoint, POST /api/auth/logout, then go to /login. */
export function LogoutRow() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Row
      title={busy ? "Logging out…" : "Log out"}
      leading={<span style={{ fontSize: 22 }}>👋</span>}
      chevron={false}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Shared phone: stop this device's pushes reaching the next person who logs in.
        await detachDeviceSubscription();
        try {
          await api.post("/api/auth/logout");
          router.replace("/login");
          router.refresh();
        } catch (err) {
          toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
          setBusy(false);
        }
      }}
    />
  );
}
