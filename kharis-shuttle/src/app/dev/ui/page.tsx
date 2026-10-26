"use client";

// Kitchen-sink page for the design system. Dev only: 404s in production.
import { notFound } from "next/navigation";
import { useState } from "react";
import { ActionBar } from "@/components/layout/ActionBar";
import { AppHeader, RoundButton } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TabBar } from "@/components/layout/TabBar";
import { ReminderBanner } from "@/components/pwa/ReminderBanner";
import {
  Art,
  Avatar,
  Badge,
  Banner,
  Button,
  Caption,
  Card,
  Checkbox,
  Empty,
  Field,
  FilterPills,
  HeroCard,
  HeroPill,
  List,
  LiveChip,
  Pill,
  Row,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatTile,
  Switch,
  useToast,
} from "@/components/ui";

const DEPARTURES = [
  { id: "1", time: "7:30 AM", seats: 12, status: "open" as const },
  { id: "2", time: "9:30 AM", seats: 3, status: "open" as const },
  { id: "3", time: "11:30 AM", seats: 0, status: "full" as const },
  { id: "4", time: "1:30 PM", seats: 14, status: "booked" as const },
  { id: "5", time: "3:30 PM", seats: 14, status: "open" as const },
];

export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Showcase />;
}

function Showcase() {
  const { toast } = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cash, setCash] = useState(true);
  const [reminders, setReminders] = useState(true);
  const [direction, setDirection] = useState<"to_campus" | "to_hostel">("to_campus");
  const [filter, setFilter] = useState<"all" | "confirmed" | "waitlist" | "boarded">("all");
  const [pin, setPin] = useState("");
  const [pickup, setPickup] = useState("gate");

  return (
    <>
      <Page>
        <AppHeader
          greeting="Good morning, Ama"
          title="Today"
          right={
            <>
              <LiveChip live label="Live" />
              <RoundButton label="Inbox" href="/dev/ui" badge={<Badge count={3} />}>
                💬
              </RoundButton>
            </>
          }
        />

        <ReminderBanner />

        <HeroCard tone="blue" title="Next shuttle 7:30 AM" subtitle="12 seats left · to KNUST campus" art="bus" cta={<HeroPill>⏱ Leaves in 42 min</HeroPill>} href="/dev/ui" />

        <div className="k-grid-2">
          <StatTile value="7:30" label="My seat · confirmed" art="seat" />
          <StatTile value="12" label="Seats left" art="ticket" />
          <StatTile value="GH₵10" label="Fare · cash only" art="cash" />
          <StatTile value="0" label="Waitlisted" zero art="clock" />
        </div>

        <Caption>Gradient tiles</Caption>
        <div className="k-grid-2">
          <StatTile tone="red" icon="hand" value="2" label="Pickup requests" art="hand" href="/dev/ui" />
          <StatTile tone="orange" icon="seat" value="36" label="Riders today" art="team" />
          <StatTile tone="teal" icon="bus" value="1" label="Bus moving" art="track" />
          <StatTile tone="purple" icon="pin" value="4" label="Pickup points" art="pin" />
        </div>

        <HeroCard tone="green" title="Bus is moving" subtitle="Left KSB 4 min ago · 9 min to hostel" art="track" disc="track" cta={<HeroPill>📍 Tap to track</HeroPill>} />

        <FilterPills
          aria-label="Filter riders"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: 14 },
            { value: "confirmed", label: "Confirmed", count: 11 },
            { value: "waitlist", label: "Waitlist", count: 3 },
            { value: "boarded", label: "Boarded" },
          ]}
        />

        <SegmentedControl
          aria-label="Direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "to_campus", label: "To campus" },
            { value: "to_hostel", label: "To hostel" },
          ]}
        />

        <List caption="Departures · today" captionAction={<a href="#" className="k-link" style={{ fontSize: 13, minHeight: 0 }}>Tomorrow ›</a>}>
          {DEPARTURES.map((d) => (
            <Row
              key={d.id}
              leading={<Art k="bus" size={32} />}
              title={d.time}
              subtitle={d.status === "full" ? "Full · join the waitlist" : d.status === "booked" ? "Your seat is confirmed · Main gate" : `${d.seats} seats left · GH₵10 cash`}
              trailing={
                d.status === "booked" ? (
                  <Pill tone="green">✅ Booked</Pill>
                ) : d.status === "full" ? (
                  <Button pill size="sm" variant="secondary" onClick={() => toast("⏳ Added to the waitlist", { tone: "amber" })}>
                    Waitlist
                  </Button>
                ) : (
                  <Button pill size="sm" onClick={() => setSheetOpen(true)}>
                    Book
                  </Button>
                )
              }
            />
          ))}
        </List>

        <List caption="Trip details">
          <Row label="Departure" value="Today, 7:30 AM" />
          <Row label="Pickup point" value="Main gate" href="/dev/ui" />
          <Row label="Fare" value="GH₵10 · cash only" />
          <Row label="Driver" value="Kwame" trailing={<a href="tel:+233200000000" aria-label="Call driver" style={{ fontSize: 20 }}>📞</a>} chevron={false} />
        </List>

        <List caption="Manifest · main gate">
          <Row leading={<Avatar name="Ama Mensah" />} title="Ama Mensah" subtitle="Room B12 · 024 000 0000" trailing={<Pill tone="green" sm>Confirmed</Pill>} />
          <Row leading={<Avatar name="Kofi Owusu" />} title="Kofi Owusu" subtitle="Room A3" trailing={<Pill tone="amber" sm>Waitlist #1</Pill>} />
          <Row leading={<Avatar name="Yaa Asantewaa" />} title="Yaa Asantewaa" subtitle="Room C7" trailing={<Pill tone="blue" sm>Boarded</Pill>} />
          <Row leading={<Avatar name="Nana" />} title="Nana" subtitle="No-show last time" trailing={<Pill tone="red" sm>No-show</Pill>} />
        </List>

        <Caption>Pills, chips, badges</Caption>
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Pill>Neutral</Pill>
            <Pill tone="blue">Blue</Pill>
            <Pill tone="green">✅ Confirmed</Pill>
            <Pill tone="amber">⏳ Waitlist</Pill>
            <Pill tone="red">Cancelled</Pill>
            <Pill tone="purple">Admin</Pill>
            <Pill tone="teal">Driver</Pill>
            <Pill tone="ghost">Ghost</Pill>
            <LiveChip live />
            <LiveChip live={false} label="Offline" />
            <Badge count={7} />
            <Badge count={120} />
          </div>
        </Card>

        <Caption>Buttons</Caption>
        <Card>
          <div className="flex flex-col gap-2">
            <Button size="big" onClick={() => toast("✅ Seat reserved", { tone: "green" })}>
              ✅ Reserve my seat
            </Button>
            <Button variant="secondary" onClick={() => toast("⚠️ Could not book — try again", { tone: "red" })}>
              Show error toast
            </Button>
            <Button loading>Working…</Button>
            <div className="flex gap-2">
              <Button variant="dangerSoft" onClick={() => toast("🗑 Seat cancelled")}>
                Cancel seat
              </Button>
              <Button variant="danger">Decline</Button>
            </div>
            <div className="flex gap-2">
              <Button pill size="sm">
                Book
              </Button>
              <Button pill size="sm" variant="secondary">
                Track
              </Button>
              <Button variant="ghost" size="sm">
                Ghost
              </Button>
            </div>
          </div>
        </Card>

        <Caption>Fields</Caption>
        <Card>
          <div className="flex flex-col gap-4">
            <Field label="Username" name="username" placeholder="ama_mensah" autoComplete="username" help="Letters, numbers and _ only." />
            <Field label="Full name" name="full_name" placeholder="Ama Mensah" error="Please enter your name." />
            <Field label="PIN" pin name="pin" type="password" value={pin} onChange={(e) => setPin(e.target.value)} help="4–6 digits. You’ll use it to log in." />
            <Field as="select" label="Pickup point" value={pickup} onChange={(e) => setPickup(e.target.value)}>
              <option value="gate">Main gate</option>
              <option value="annex">Annex block</option>
              <option value="junction">Ayeduase junction</option>
            </Field>
            <Field as="textarea" label="Note for the driver" placeholder="I’ll be at the gate with a suitcase" />
          </div>
        </Card>

        <List caption="Settings">
          <Row title="Shuttle reminders" subtitle="Before each departure" trailing={<Switch checked={reminders} onChange={setReminders} label="Shuttle reminders" />} />
          <Row title="Change PIN" href="/dev/ui" />
          <Row title="Log out" onClick={() => toast("👋 Logged out")} chevron={false} />
        </List>

        <Card>
          <Checkbox checked={cash} onChange={setCash} label="I’ll pay the driver GH₵10 in cash" hint="No mobile money yet." />
        </Card>

        <Banner tone="amber" icon="🔔" action={{ label: "Turn on", href: "/dev/ui" }}>
          Reminders are off — you could miss the shuttle.
        </Banner>
        <Banner tone="red" icon="⚠️">
          Tracking paused — return to the app to keep sharing.
        </Banner>
        <Banner tone="blue" icon="📍" action={{ label: "Track", onClick: () => toast("📍 Opening map") }}>
          Shuttle is at KSB heading to the hostel.
        </Banner>
        <Banner tone="green" icon="✅">
          Reminders are on.
        </Banner>

        <Card>
          <Empty art="calendar" title="No shuttles tomorrow" hint="Sunday is a day off. Check again on Monday." action={<Button pill variant="secondary">🔄 Refresh</Button>} />
        </Card>

        <Skeleton card lines={3} />
        <List>
          <Row leading={<div className="k-skeleton" style={{ width: 32, height: 32, borderRadius: 16 }} />}>
            <Skeleton lines={2} widths={["55%", "80%"]} />
          </Row>
          <Row leading={<div className="k-skeleton" style={{ width: 32, height: 32, borderRadius: 16 }} />}>
            <Skeleton lines={2} widths={["40%", "70%"]} />
          </Row>
        </List>

        <Caption>Inbox bubbles</Caption>
        <div className="flex flex-col gap-2">
          <div className="k-bubble k-bubble--in">🚌 Shuttle at 7:30 AM. 12/14 seats left. GH₵10 cash. Tap to opt in.</div>
          <div className="k-bubble k-bubble--out">✅ Seat reserved for 7:30 AM at Main gate.</div>
          <div className="k-bubble k-bubble--in">📍 Shuttle is at KSB heading to the hostel. Leaving in 10 min.</div>
        </div>

        <ActionBar>
          <Button size="big" onClick={() => setSheetOpen(true)}>
            💺 Book 7:30 AM
          </Button>
        </ActionBar>
      </Page>

      <TabBar
        items={[
          { href: "/dev/ui", label: "Today", art: "bus" },
          { href: "/dev/live", label: "Live", art: "track" },
          { href: "/dev/inbox", label: "Inbox", art: "chat", badge: 3 },
          { href: "/dev/me", label: "Me", art: "roles" },
        ]}
      />

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Reserve a seat" footer={<Button size="big" onClick={() => { setSheetOpen(false); toast("✅ Seat reserved", { tone: "green" }); }}>✅ Reserve my seat</Button>}>
        <List>
          <Row label="Departure" value="Today, 7:30 AM" />
          <Row label="Pickup point" value="Main gate" onClick={() => undefined} />
          <Row label="Fare" value="GH₵10 · cash only" />
        </List>
        <Checkbox checked={cash} onChange={setCash} label="I’ll pay the driver in cash" />
      </Sheet>
    </>
  );
}
