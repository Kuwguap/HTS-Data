"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useStandalone } from "@/hooks/useStandalone";
import { Art } from "@/components/ui/Art";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { APP_SHORT_NAME } from "@/lib/constants";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    window.dispatchEvent(new Event("kharis:installprompt"));
  });
}

function Step({ n, emoji, title, children }: { n: number; emoji: string; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3" style={{ padding: "10px 0" }}>
      <span
        aria-hidden="true"
        style={{
          flex: "0 0 28px",
          width: 28,
          height: 28,
          borderRadius: 999,
          background: "var(--accent)",
          color: "var(--on-accent)",
          fontSize: 14,
          fontWeight: 800,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 4,
        }}
      >
        {n}
      </span>
      <Art emoji={emoji} size={36} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--fs-lg)", fontWeight: 600 }}>{title}</span>
        {children ? <span style={{ display: "block", color: "var(--hint)", fontSize: "var(--fs-md)", marginTop: 2 }}>{children}</span> : null}
      </span>
    </li>
  );
}

export type InstallGateProps = {
  /** Shown above the steps on iOS; defaults to the standard explanation. */
  intro?: ReactNode;
  className?: string;
};

/**
 * Install guidance by platform. Renders nothing when already installed
 * (standalone) or before hydration.
 * - iOS: illustrated 3 steps (Share → Add to Home Screen → open from Home Screen).
 * - Android: an "Install app" button when the browser offers it, else the menu hint.
 * - Desktop: a one-line "open on your phone" hint.
 */
export function InstallGate({ intro, className }: InstallGateProps) {
  const env = useStandalone();
  const [canPrompt, setCanPrompt] = useState(false);

  useEffect(() => {
    const sync = () => setCanPrompt(deferredPrompt !== null);
    window.addEventListener("kharis:installprompt", sync);
    const t = window.setTimeout(sync, 0);
    return () => {
      window.removeEventListener("kharis:installprompt", sync);
      window.clearTimeout(t);
    };
  }, []);

  if (!env.ready || env.isStandalone) return null;

  if (env.isIOS) {
    return (
      <Card className={className}>
        <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
          <Art k="bus" size={40} />
          <div>
            <h3 style={{ fontSize: 20, fontWeight: 800 }}>Add {APP_SHORT_NAME} to your Home Screen</h3>
            <p style={{ color: "var(--hint)", fontSize: "var(--fs-sm)", margin: "2px 0 0" }}>
              {intro ?? "Reminders only work from the installed app. It takes 10 seconds."}
            </p>
          </div>
        </div>
        {!env.isIOSSafari ? (
          <p className="k-banner k-banner--blue" style={{ margin: "8px 0" }}>
            <span aria-hidden="true">🧭</span>
            <span>Open this page in Safari first — only Safari can add it to your Home Screen.</span>
          </p>
        ) : null}
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <Step n={1} emoji="📤" title="Tap the Share button">
            The square with an arrow at the bottom of Safari.
          </Step>
          <Step n={2} emoji="➕" title="Choose “Add to Home Screen”">
            Scroll down the list a little if you don’t see it.
          </Step>
          <Step n={3} emoji="🚌" title={`Open ${APP_SHORT_NAME} from your Home Screen`}>
            Log in there once, then turn on reminders.
          </Step>
        </ol>
      </Card>
    );
  }

  if (env.isAndroid) {
    return (
      <Card className={className}>
        <div className="flex items-center gap-3">
          <Art k="bus" size={40} />
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 20, fontWeight: 800 }}>Install the app</h3>
            <p style={{ color: "var(--hint)", fontSize: "var(--fs-sm)", margin: "2px 0 0" }}>
              {canPrompt ? "Get reminders and a quicker way in." : "In Chrome, open the ⋮ menu and tap “Add to Home screen” or “Install app”."}
            </p>
          </div>
        </div>
        {canPrompt ? (
          <div style={{ marginTop: 12 }}>
            <Button
              size="big"
              onClick={async () => {
                const p = deferredPrompt;
                if (!p) return;
                await p.prompt();
                const choice = await p.userChoice.catch(() => ({ outcome: "dismissed" as const }));
                if (choice.outcome === "accepted") deferredPrompt = null;
                setCanPrompt(deferredPrompt !== null);
              }}
            >
              ⬇️ Install app
            </Button>
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <p className={["k-banner k-banner--blue", className ?? ""].join(" ").trim()}>
      <span aria-hidden="true">📱</span>
      <span>Open this page on your phone to install the app.</span>
    </p>
  );
}

/** "Copy link" button for the install page (lives here so the page stays a server component). */
export function CopyLinkButton({ url, label = "🔗 Copy link" }: { url: string; label?: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast("✅ Link copied", { tone: "green" });
        } catch {
          toast("⚠️ Could not copy — long-press the link instead", { tone: "amber" });
        }
      }}
    >
      {label}
    </Button>
  );
}
