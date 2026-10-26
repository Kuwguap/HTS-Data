import type { Metadata } from "next";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { CopyLinkButton, InstallGate } from "@/components/pwa/InstallGate";
import { Card } from "@/components/ui/Card";
import { List } from "@/components/ui/List";
import { Row } from "@/components/ui/Row";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Install the app",
  description: "Add Kharis Shuttle to your iPhone or Android home screen to get departure reminders.",
};

export default function InstallPage() {
  const appUrl = publicEnv.appUrl || "https://shuttle.example.com";
  return (
    <Page noTabs>
      <AppHeader title="Install the app" back="/" />
      <InstallGate />
      <List caption="Why install?">
        <Row leading={<span aria-hidden="true" style={{ fontSize: 22 }}>🔔</span>} title="Reminders before each shuttle" subtitle="Only the installed app can notify you on iPhone." />
        <Row leading={<span aria-hidden="true" style={{ fontSize: 22 }}>💺</span>} title="One-tap seat booking" subtitle="Pick your pickup point and pay the driver in cash." />
        <Row leading={<span aria-hidden="true" style={{ fontSize: 22 }}>🛰️</span>} title="Live bus position" subtitle="See where the shuttle is before you go downstairs." />
      </List>
      <Card title="Share the link">
        <p style={{ color: "var(--hint)", fontSize: "var(--fs-md)", margin: "0 0 12px", overflowWrap: "anywhere" }}>
          <a href={appUrl}>{appUrl}</a>
        </p>
        <CopyLinkButton url={appUrl} />
      </Card>
    </Page>
  );
}
