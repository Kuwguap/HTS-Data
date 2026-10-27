"use client";

import Link from "next/link";
import { useState } from "react";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useStandalone } from "@/hooks/useStandalone";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { APP_SHORT_NAME } from "@/lib/constants";

export type EnableNotificationsProps = {
  /** Called after a successful subscribe (e.g. advance the onboarding step). */
  onEnabled?: () => void;
  /** Send a test push right after subscribing (default true). */
  testAfterEnable?: boolean;
  /** Show a "Turn off" link when on (default false; settings pages want it). */
  allowDisable?: boolean;
  className?: string;
};

/**
 * The "🔔 Turn on reminders" control with every push state handled:
 * needs-install (iOS browser), unsupported, denied (with the Settings path),
 * off → working → on (with "Send me a test").
 */
export function EnableNotifications({ onEnabled, testAfterEnable = true, allowDisable, className }: EnableNotificationsProps) {
  const push = usePushSubscription();
  const env = useStandalone();
  const { toast } = useToast();
  const [testing, setTesting] = useState(false);

  const enable = async () => {
    const result = await push.subscribe();
    if (!result.ok) {
      toast(`⚠️ ${result.error ?? "Could not turn on reminders — try again"}`, { tone: "red" });
      return;
    }
    toast("✅ Reminders are on", { tone: "green" });
    onEnabled?.();
    if (testAfterEnable) {
      // Subscribing worked; the test says whether the push service actually delivers here.
      const test = await push.sendTest();
      toast(test.ok ? "📨 Test sent — check your notifications" : `⚠️ ${test.error ?? "Could not send a test — try again"}`, {
        tone: test.ok ? "green" : "amber",
      });
    }
  };

  const test = async () => {
    setTesting(true);
    const result = await push.sendTest();
    setTesting(false);
    toast(result.ok ? "📨 Test sent — check your notifications" : `⚠️ ${result.error ?? "Could not send a test — try again"}`, {
      tone: result.ok ? "green" : "red",
    });
  };

  const disable = async () => {
    const result = await push.unsubscribe();
    toast(result.ok ? "🔕 Reminders are off" : `⚠️ ${result.error ?? "Could not turn off reminders — try again"}`, { tone: result.ok ? "amber" : "red" });
  };

  if (push.status === "needs-install") {
    return (
      <Banner tone="blue" icon="📲" action={{ label: "How to install", href: "/install" }} className={className}>
        Install the app first — iPhone only allows reminders from the Home Screen app.
      </Banner>
    );
  }

  if (push.status === "unsupported") {
    return (
      <Banner tone="amber" icon="🙈" className={className}>
        This browser can’t show reminders. Try Chrome or Safari on your phone.
      </Banner>
    );
  }

  if (push.status === "denied") {
    return (
      <Card className={className}>
        <h3 style={{ fontSize: 17, fontWeight: 700 }}>🔕 Reminders are blocked</h3>
        <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "6px 0 0" }}>
          {env.isIOS ? (
            <>
              Open <strong>Settings → Notifications → {APP_SHORT_NAME}</strong> and turn on <strong>Allow Notifications</strong>, then come back here.
            </>
          ) : env.isAndroid ? (
            <>
              Open your browser’s <strong>Site settings → Notifications</strong> for this app and allow them, then come back here.
            </>
          ) : (
            <>Allow notifications for this site in your browser settings, then reload.</>
          )}
        </p>
      </Card>
    );
  }

  if (push.status === "on") {
    return (
      <div className={["flex flex-col gap-2", className ?? ""].join(" ").trim()}>
        <Banner tone="green" icon="✅">
          Reminders are on. You’ll hear about each departure before it leaves.
        </Banner>
        <div className="flex items-center justify-between" style={{ padding: "0 4px" }}>
          <button type="button" className="k-link" style={{ fontSize: "var(--fs-md)" }} onClick={test} disabled={testing}>
            {testing ? "Sending…" : "📨 Send me a test"}
          </button>
          {allowDisable ? (
            <button type="button" className="k-link" style={{ fontSize: "var(--fs-md)", color: "var(--hint)" }} onClick={disable}>
              Turn off
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={["flex flex-col gap-2", className ?? ""].join(" ").trim()}>
      <Button size="big" onClick={enable} loading={push.status === "working"}>
        🔔 Turn on reminders
      </Button>
      <p style={{ color: "var(--hint)", fontSize: "var(--fs-sm)", textAlign: "center", margin: 0 }}>
        A reminder before each shuttle, and a nudge when it’s about to leave. No spam.{" "}
        {!env.isStandalone && !env.isIOS ? (
          <>
            <Link href="/install">Install the app</Link> for the best experience.
          </>
        ) : null}
      </p>
    </div>
  );
}
