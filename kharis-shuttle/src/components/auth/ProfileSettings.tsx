"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EnableNotifications } from "@/components/pwa/EnableNotifications";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { List } from "@/components/ui/List";
import { Pill } from "@/components/ui/Pill";
import { Row } from "@/components/ui/Row";
import { Sheet } from "@/components/ui/Sheet";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useStandalone } from "@/hooks/useStandalone";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { PublicProfile } from "@/lib/auth/session";
import { APP_NAME } from "@/lib/constants";
import { PIN_RE } from "@/lib/validation/common";
import { LogoutButton } from "./LogoutButton";

export type ProfileSettingsProps = {
  profile: PublicProfile;
  /** package.json version, read on the server. */
  appVersion: string;
  /** Hostel office number for the PIN-reset hint. */
  enquiryPhone?: string | null;
};

type MeResponse = { profile: PublicProfile; home: string };
type PushTestResponse = { sent: boolean; delivered: number; devices: number; pruned: number; status: string | null };

const ROLE_LABEL: Record<PublicProfile["role"], string> = { student: "Student", driver: "Driver", admin: "Admin" };
const ROLE_TONE: Record<PublicProfile["role"], "blue" | "teal" | "purple"> = { student: "blue", driver: "teal", admin: "purple" };

/**
 * The "Me" screen body: profile, reminders, app, security, log out. Shared by
 * student (/app/settings), driver and admin pages — each page supplies the header.
 */
export function ProfileSettings({ profile: initial, appVersion, enquiryPhone }: ProfileSettingsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const env = useStandalone();
  const [profile, setProfile] = useState(initial);

  // ----- edit details sheet -----
  const [editOpen, setEditOpen] = useState(false);
  const [fullName, setFullName] = useState(initial.full_name);
  const [room, setRoom] = useState(initial.room ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [editBusy, setEditBusy] = useState(false);
  const [editErrors, setEditErrors] = useState<{ full_name?: string; room?: string; phone?: string }>({});

  const openEdit = () => {
    setFullName(profile.full_name);
    setRoom(profile.room ?? "");
    setPhone(profile.phone ?? "");
    setEditErrors({});
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (editBusy) return;
    if (fullName.trim().length < 2) {
      setEditErrors({ full_name: "Enter your full name" });
      return;
    }
    setEditBusy(true);
    setEditErrors({});
    try {
      const res = await api.patch<MeResponse>("/api/me", {
        full_name: fullName.trim(),
        room: room.trim() || null,
        phone: phone.trim() || null,
      });
      setProfile(res.profile);
      setEditOpen(false);
      toast("✅ Details saved", { tone: "green" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "VALIDATION") {
        setEditErrors({ full_name: err.fieldError("full_name"), room: err.fieldError("room"), phone: err.fieldError("phone") });
      }
      toast(`⚠️ ${errorMessage(err, "Could not save — try again")}`, { tone: "red" });
    } finally {
      setEditBusy(false);
    }
  };

  // ----- reminders toggle -----
  const [remBusy, setRemBusy] = useState(false);
  const toggleReminders = async (next: boolean) => {
    if (remBusy) return;
    const prev = profile.reminders_enabled;
    setProfile((p) => ({ ...p, reminders_enabled: next }));
    setRemBusy(true);
    try {
      const res = await api.patch<MeResponse>("/api/me", { reminders_enabled: next });
      setProfile(res.profile);
      toast(next ? "🔔 Reminders on" : "🔕 Reminders off", { tone: next ? "green" : "amber" });
      router.refresh();
    } catch (err) {
      setProfile((p) => ({ ...p, reminders_enabled: prev }));
      toast(`⚠️ ${errorMessage(err, "Could not update — try again")}`, { tone: "red" });
    } finally {
      setRemBusy(false);
    }
  };

  // ----- test push -----
  const [testBusy, setTestBusy] = useState(false);
  const sendTest = async () => {
    if (testBusy) return;
    setTestBusy(true);
    try {
      const res = await api.post<PushTestResponse>("/api/push/test");
      if (res.delivered > 0) {
        toast(`✅ Sent to ${res.delivered} device${res.delivered === 1 ? "" : "s"}`, { tone: "green" });
      } else if (res.devices === 0) {
        toast(
          res.pruned > 0
            ? "⚠️ Your old subscription expired — turn on reminders again"
            : "⚠️ No device is subscribed yet — turn on reminders first",
          { tone: "amber" },
        );
      } else {
        toast(`⚠️ Could not deliver (${res.status ?? "failed"}) — try again in a moment`, { tone: "red" });
      }
    } catch (err) {
      toast(`⚠️ ${errorMessage(err, "Could not send a test — try again")}`, { tone: "red" });
    } finally {
      setTestBusy(false);
    }
  };

  // ----- change PIN sheet -----
  const [pinOpen, setPinOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPins, setShowPins] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinErrors, setPinErrors] = useState<{ current_pin?: string; new_pin?: string; confirm?: string }>({});

  const openPin = () => {
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setPinErrors({});
    setShowPins(false);
    setPinOpen(true);
  };

  const savePin = async () => {
    if (pinBusy) return;
    const errs: typeof pinErrors = {};
    if (!PIN_RE.test(currentPin)) errs.current_pin = "Enter your current PIN";
    if (!PIN_RE.test(newPin)) errs.new_pin = "PIN must be 4–6 digits";
    else if (newPin === currentPin) errs.new_pin = "Choose a different PIN from your current one";
    if (newPin !== confirmPin) errs.confirm = "PINs don't match";
    setPinErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setPinBusy(true);
    try {
      // A wrong current PIN is 401 INVALID_CREDENTIALS (handled inline below); only
      // 401 UNAUTHENTICATED (session gone) makes the helper bounce to /login?next=….
      await api.post<{ ok: true }>("/api/auth/pin", { current_pin: currentPin, new_pin: newPin });
      setPinOpen(false);
      toast("✅ PIN changed", { tone: "green" });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "INVALID_CREDENTIALS") setPinErrors({ current_pin: err.message });
        else if (err.code === "UNAUTHENTICATED") return; // the api helper is already navigating to /login
        else if (err.code === "VALIDATION") {
          setPinErrors({ current_pin: err.fieldError("current_pin"), new_pin: err.fieldError("new_pin") ?? err.message });
        } else toast(`⚠️ ${err.message}`, { tone: "red" });
      } else {
        toast("⚠️ Could not change the PIN — try again", { tone: "red" });
      }
    } finally {
      setPinBusy(false);
    }
  };

  const tel = enquiryPhone ? enquiryPhone.replace(/\s+/g, "") : null;
  const installValue = !env.ready ? "…" : env.isStandalone ? "✅ Home Screen app" : env.isIOS ? "Safari · not installed" : "Browser";
  const pinType = showPins ? "text" : "password";

  return (
    <>
      <List caption="Profile">
        <Row
          leading={<Avatar name={profile.full_name} />}
          title={profile.full_name}
          subtitle={`@${profile.username}`}
          trailing={<Pill tone={ROLE_TONE[profile.role]} sm>{ROLE_LABEL[profile.role]}</Pill>}
          onClick={openEdit}
          chevron
          aria-label="Edit name"
        />
        <Row label="Room" value={profile.room || "—"} onClick={openEdit} chevron aria-label="Edit room" />
        <Row label="Phone" value={profile.phone || "—"} onClick={openEdit} chevron aria-label="Edit phone" />
      </List>

      <List caption="Reminders">
        <Row
          title="Shuttle reminders"
          subtitle="Before each departure, and a nudge when it's about to leave"
          trailing={<Switch checked={profile.reminders_enabled} onChange={toggleReminders} label="Shuttle reminders" disabled={remBusy} />}
        />
        <Row>
          <EnableNotifications allowDisable testAfterEnable={false} />
        </Row>
        <Row title="Send me a test notification" subtitle="Checks this device can receive pushes" onClick={sendTest} disabled={testBusy} trailing={testBusy ? <Pill sm>Sending…</Pill> : <span aria-hidden="true">📨</span>} />
      </List>

      <List caption="App">
        {env.ready && !env.isStandalone ? (
          <Row label="Installed" value={installValue} href="/install" />
        ) : (
          <Row label="Installed" value={installValue} />
        )}
        <Row label="Version" value={`${APP_NAME} ${appVersion}`} />
      </List>

      <List caption="Security">
        <Row title="Change PIN" subtitle="4–6 digits" onClick={openPin} chevron />
        <Row
          title="Forgot your PIN?"
          subtitle="Ask the hostel office to reset it"
          trailing={tel ? <a href={`tel:${tel}`} aria-label="Call the hostel office" style={{ fontSize: 20 }}>📞</a> : undefined}
        />
      </List>

      <LogoutButton />

      <Sheet
        open={editOpen}
        onClose={() => (editBusy ? undefined : setEditOpen(false))}
        title="Edit details"
        footer={
          <Button size="big" onClick={saveEdit} loading={editBusy}>
            ✅ Save
          </Button>
        }
      >
        <Field label="Full name" name="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={80} disabled={editBusy} error={editErrors.full_name} />
        <Field label="Username" name="username" value={`@${profile.username}`} readOnly disabled help="Usernames can't be changed." />
        <Field label="Room" name="room" value={room} onChange={(e) => setRoom(e.target.value)} autoCapitalize="characters" placeholder="B12" maxLength={20} disabled={editBusy} error={editErrors.room} />
        <Field label="Phone" name="phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="024 000 0000" maxLength={30} disabled={editBusy} error={editErrors.phone} />
      </Sheet>

      <Sheet
        open={pinOpen}
        onClose={() => (pinBusy ? undefined : setPinOpen(false))}
        title="Change PIN"
        footer={
          <Button size="big" onClick={savePin} loading={pinBusy} disabled={!currentPin || !newPin || !confirmPin}>
            🔐 Change PIN
          </Button>
        }
      >
        <Field label="Current PIN" name="current_pin" pin type={pinType} value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="current-password" disabled={pinBusy} error={pinErrors.current_pin} />
        <Field label="New PIN" name="new_pin" pin type={pinType} value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="new-password" disabled={pinBusy} error={pinErrors.new_pin} />
        <Field
          label="Confirm new PIN"
          name="confirm_pin"
          pin
          type={pinType}
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          autoComplete="new-password"
          disabled={pinBusy}
          error={pinErrors.confirm}
          help={
            <button type="button" className="k-link" style={{ minHeight: 32, fontSize: "var(--fs-sm)" }} onClick={() => setShowPins((s) => !s)}>
              {showPins ? "🙈 Hide PINs" : "👁 Show PINs"}
            </button>
          }
        />
      </Sheet>
    </>
  );
}
