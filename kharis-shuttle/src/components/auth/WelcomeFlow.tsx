"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { EnableNotifications } from "@/components/pwa/EnableNotifications";
import { InstallGate } from "@/components/pwa/InstallGate";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { List } from "@/components/ui/List";
import { Pill } from "@/components/ui/Pill";
import { Row } from "@/components/ui/Row";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useStandalone } from "@/hooks/useStandalone";
import { ApiClientError, api } from "@/lib/api-client";
import type { PublicProfile } from "@/lib/auth/session";
import { APP_NAME, HOME_BY_ROLE } from "@/lib/constants";
import type { Settings } from "@/lib/db.types";

export type WelcomeFlowProps = {
  profile: PublicProfile;
  settings: Pick<Settings, "hostel_name" | "campus_name" | "enquiry_phone">;
};

type Step = 1 | 2 | 3;
const TOTAL = 3;

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function WelcomeFlow({ profile, settings }: WelcomeFlowProps) {
  const router = useRouter();
  const { toast } = useToast();
  const env = useStandalone();
  const push = usePushSubscription();
  const [chosenStep, setStep] = useState<Step>(1);
  const [room, setRoom] = useState(profile.room ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [reminders, setReminders] = useState(profile.reminders_enabled);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ room?: string; phone?: string }>({});

  const isStaff = profile.role !== "student";
  const needsInstall = env.ready && env.isIOS && !env.isStandalone;

  // Step 1 only matters on an iPhone browser; everyone else lands on reminders (derived, no effect).
  const step: Step = chosenStep === 1 && env.ready && !needsInstall ? 2 : chosenStep;

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    try {
      const res = await api.patch<{ profile: PublicProfile; home: string }>("/api/me", {
        room: room.trim() || null,
        phone: phone.trim() || null,
        reminders_enabled: reminders,
        onboarded: true,
      });
      toast("🎉 You're all set", { tone: "green" });
      router.replace(res.home || HOME_BY_ROLE[profile.role]);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "VALIDATION") {
        setFieldErrors({ room: err.fieldError("room"), phone: err.fieldError("phone") });
      }
      toast(`⚠️ ${err instanceof Error && err.message ? err.message : "Could not save — try again"}`, { tone: "red" });
      setBusy(false);
    }
  };

  const progress = <Pill tone="blue">{`Step ${step} of ${TOTAL}`}</Pill>;

  return (
    <Page noTabs>
      <AppHeader greeting={`Hi ${firstName(profile.full_name)} 👋`} title={`Welcome to ${APP_NAME}`} right={progress} />

      {step === 1 ? (
        !env.ready ? (
          <Skeleton card lines={3} />
        ) : (
          <>
            <Card>
              <h2 className="k-group-title" style={{ fontSize: 20 }}>📲 Install the app</h2>
              <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "6px 0 0" }}>
                iPhone only sends shuttle reminders to apps on your Home Screen. Add {APP_NAME} there first.
              </p>
            </Card>
            <InstallGate intro="Three taps in Safari. Reminders only work from the installed app." />
            <Banner tone="blue" icon="🔑">
              I&apos;ve installed it — I&apos;ll open it from my Home Screen. The installed app keeps its own login, so log in again there to
              finish setup.
            </Banner>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Skip for now
            </Button>
          </>
        )
      ) : null}

      {step === 2 ? (
        <>
          <Card>
            <h2 className="k-group-title" style={{ fontSize: 20 }}>🔔 Turn on reminders</h2>
            <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "6px 0 0" }}>
              {isStaff
                ? `We'll send you the rider list before each trip and tell you the moment someone asks for a pickup.`
                : `We'll remind you before each shuttle so you can grab a seat, and nudge you when it's about to leave.`}
            </p>
          </Card>
          <EnableNotifications onEnabled={() => setStep(3)} />
          {push.status === "on" ? (
            <Button size="big" onClick={() => setStep(3)}>
              ➡️ Continue
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setStep(3)}>
              Skip for now
            </Button>
          )}
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Card>
            <h2 className="k-group-title" style={{ fontSize: 20 }}>🧑 Your details</h2>
            <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "6px 0 14px" }}>
              {isStaff
                ? `So the ${settings.hostel_name} office and riders can reach you.`
                : `So the driver knows where to find you at ${settings.hostel_name}.`}
            </p>
            <div className="flex flex-col gap-4">
              <Field label="Room" name="room" value={room} onChange={(e) => setRoom(e.target.value)} autoCapitalize="characters" placeholder="B12" maxLength={20} disabled={busy} error={fieldErrors.room} />
              <Field
                label="Phone"
                name="phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder="024 000 0000"
                maxLength={30}
                disabled={busy}
                error={fieldErrors.phone}
                help={isStaff ? "Riders see this on their booking." : "The driver may call you at the pickup point."}
              />
            </div>
          </Card>
          <List caption="Reminders">
            <Row
              title={isStaff ? "Trip alerts" : "Shuttle reminders"}
              subtitle={isStaff ? "Rider lists and pickup requests" : `Before each departure to ${settings.campus_name}`}
              trailing={<Switch checked={reminders} onChange={setReminders} label="Shuttle reminders" disabled={busy} />}
            />
          </List>
          <Button size="big" onClick={finish} loading={busy}>
            ✅ Done
          </Button>
        </>
      ) : null}
    </Page>
  );
}
