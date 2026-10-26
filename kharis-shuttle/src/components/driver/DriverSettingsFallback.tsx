"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, api } from "@/lib/api-client";
import { APP_NAME } from "@/lib/constants";
import type { Profile } from "@/lib/db.types";
import { EnableNotifications } from "@/components/pwa/EnableNotifications";
import { Avatar, Button, Caption, Card, List, Pill, Row, useToast } from "@/components/ui";

export type DriverSettingsFallbackProps = {
  profile: Pick<Profile, "id" | "full_name" | "username" | "phone" | "room" | "role" | "reminders_enabled">;
};

/**
 * Minimal "Me" screen for drivers, used until the shared <ProfileSettings/>
 * (components/auth/ProfileSettings.tsx) exists: profile rows, notifications, log out.
 */
export function DriverSettingsFallback({ profile }: DriverSettingsFallbackProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.post("/api/auth/logout");
      toast("👋 Logged out");
      router.replace("/login");
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not log out — try again")}`, { tone: "red" });
      setLoggingOut(false);
    }
  };

  return (
    <>
      <Card>
        <div className="flex items-center gap-3">
          <Avatar name={profile.full_name} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{profile.full_name}</div>
            <div style={{ color: "var(--hint)", fontSize: "var(--fs-sm)" }}>@{profile.username}</div>
          </div>
          <Pill tone={profile.role === "admin" ? "purple" : "teal"}>{profile.role === "admin" ? "Admin" : "Driver"}</Pill>
        </div>
      </Card>

      <List caption="Profile">
        <Row label="Name" value={profile.full_name} />
        <Row label="Phone" value={profile.phone ?? "—"} />
        <Row label="Room" value={profile.room ?? "—"} />
      </List>

      <div>
        <Caption>Notifications</Caption>
        <EnableNotifications allowDisable testAfterEnable={false} />
        <p style={{ margin: "8px 4px 0", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
          {APP_NAME} sends you the rider list before each departure and new pickup requests.
        </p>
      </div>

      <Caption>Account</Caption>
      <Button variant="dangerSoft" onClick={logout} loading={loggingOut}>
        👋 Log out
      </Button>
    </>
  );
}
