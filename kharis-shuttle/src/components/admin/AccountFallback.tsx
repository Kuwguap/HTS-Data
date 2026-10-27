"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, List, Row, Sheet, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { Profile } from "@/lib/db.types";
import { STAFF_ALERTS_TITLE, staffAlertsSubtitle } from "@/components/auth/staffAlerts";

type Props = { profile: Pick<Profile, "id" | "username" | "full_name" | "phone" | "room" | "role" | "reminders_enabled"> };

/**
 * Minimal "My account" screen for admins (name/phone/room, reminders, change PIN,
 * log out) used until the shared <ProfileSettings/> from the auth area lands.
 * Talks to PATCH /api/me, POST /api/auth/pin and POST /api/auth/logout.
 */
export function AccountFallback({ profile }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminders, setReminders] = useState(profile.reminders_enabled);
  const [fullName, setFullName] = useState(profile.full_name);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [room, setRoom] = useState(profile.room ?? "");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const fieldErrors = (err: unknown, fields: string[]) => {
    const out: Record<string, string | undefined> = {};
    if (err instanceof ApiClientError) for (const f of fields) out[f] = err.fieldError(f);
    setErrors(out);
  };

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch("/api/me", { full_name: fullName, phone: phone || null, room: room || null });
      toast("✅ Details saved", { tone: "green" });
      setEditOpen(false);
      router.refresh();
    } catch (err) {
      fieldErrors(err, ["full_name", "phone", "room"]);
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleReminders(next: boolean) {
    setReminders(next);
    try {
      await api.patch("/api/me", { reminders_enabled: next });
      toast(next ? "🔔 Reminders on" : "🔕 Reminders off");
    } catch (err) {
      setReminders(!next);
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    }
  }

  async function changePin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/auth/pin", { current_pin: currentPin, new_pin: newPin });
      toast("✅ PIN changed", { tone: "green" });
      setPinOpen(false);
      setCurrentPin("");
      setNewPin("");
    } catch (err) {
      fieldErrors(err, ["current_pin", "new_pin"]);
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <List caption="Profile">
        <Row label="Name" value={profile.full_name} onClick={() => setEditOpen(true)} chevron />
        <Row label="Username" value={`@${profile.username}`} />
        <Row label="Phone" value={profile.phone ?? "—"} onClick={() => setEditOpen(true)} chevron />
        <Row label="Room" value={profile.room ?? "—"} onClick={() => setEditOpen(true)} chevron />
        <Row label="Role" value={profile.role} />
      </List>

      <List caption="Notifications">
        {profile.role === "student" ? (
          <Row title="Shuttle reminders" subtitle="Daily announcement and trip reminders" trailing={<Switch checked={reminders} onChange={toggleReminders} label="Shuttle reminders" />} />
        ) : (
          // Duty alerts: delivery ignores reminders_enabled for drivers and admins, so there is nothing to toggle.
          <Row title={STAFF_ALERTS_TITLE} subtitle={staffAlertsSubtitle(profile.role)} />
        )}
      </List>

      <List caption="Security">
        <Row title="Change PIN" onClick={() => setPinOpen(true)} chevron />
      </List>

      <Sheet
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit details"
        footer={
          <Button size="big" type="submit" form="account-edit" loading={busy}>
            ✅ Save
          </Button>
        }
      >
        <form id="account-edit" onSubmit={saveProfile} className="flex flex-col gap-3">
          <Field label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.full_name} autoComplete="name" required />
          <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} type="tel" inputMode="tel" autoComplete="tel" placeholder="024 000 0000" />
          <Field label="Room" value={room} onChange={(e) => setRoom(e.target.value)} error={errors.room} placeholder="B12" />
        </form>
      </Sheet>

      <Sheet
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        title="Change PIN"
        footer={
          <Button size="big" type="submit" form="account-pin" loading={busy}>
            🔑 Change PIN
          </Button>
        }
      >
        <form id="account-pin" onSubmit={changePin} className="flex flex-col gap-3">
          <Field label="Current PIN" pin type="password" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} error={errors.current_pin} autoComplete="current-password" />
          <Field label="New PIN" pin type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} error={errors.new_pin} help="4–6 digits." autoComplete="new-password" />
        </form>
      </Sheet>
    </>
  );
}
