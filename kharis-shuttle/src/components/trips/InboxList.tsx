"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { Empty } from "@/components/ui";

export type InboxItem = {
  id: string;
  title: string;
  body: string;
  url: string | null;
  /** "Today" / "Yesterday" / "Mon 27 Oct" — computed on the server in the hostel timezone. */
  dayLabel: string;
  /** "7:30 AM" */
  timeLabel: string;
  unread: boolean;
};

export type InboxListProps = {
  items: InboxItem[];
};

/**
 * Chat-style inbox: incoming bubbles grouped by day. Unread ones keep their
 * blue dot for this visit while being marked read on mount.
 */
export function InboxList({ items }: InboxListProps) {
  const router = useRouter();
  const [seen] = useState<Set<string>>(() => new Set(items.filter((i) => i.unread).map((i) => i.id)));
  const marked = useRef(false);

  useEffect(() => {
    if (marked.current) return;
    const ids = items.filter((i) => i.unread).map((i) => i.id);
    if (ids.length === 0) return;
    marked.current = true;
    api
      .post("/api/notifications/read", { ids })
      .then(() => router.refresh())
      .catch(() => {
        marked.current = false;
      });
  }, [items, router]);

  if (items.length === 0) {
    return (
      <div className="k-card">
        <Empty art="chat" title="Nothing here yet" hint="Reminders, seat confirmations and driver updates will show up here." />
      </div>
    );
  }

  const groups: Array<{ day: string; items: InboxItem[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.day === item.dayLabel) last.items.push(item);
    else groups.push({ day: item.dayLabel, items: [item] });
  }

  const open = (item: InboxItem) => {
    if (item.url && item.url.startsWith("/")) router.push(item.url);
  };

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.day} className="flex flex-col gap-2">
          <div className="k-caption" style={{ textAlign: "center", padding: "4px 0" }}>
            {g.day}
          </div>
          {g.items.map((item) => {
            const unread = seen.has(item.id);
            const interactive = Boolean(item.url);
            const Tag = interactive ? "button" : "div";
            return (
              <div key={item.id} className="flex items-end gap-2" style={{ maxWidth: "100%" }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    flex: "0 0 8px",
                    marginBottom: 14,
                    background: unread ? "var(--accent)" : "transparent",
                  }}
                />
                <Tag
                  type={interactive ? "button" : undefined}
                  onClick={interactive ? () => open(item) : undefined}
                  className="k-bubble k-bubble--in"
                  style={{ textAlign: "left", cursor: interactive ? "pointer" : "default", maxWidth: "92%" }}
                  aria-label={unread ? `Unread: ${item.title}` : undefined}
                >
                  <span style={{ display: "block", fontWeight: 700 }}>{item.title}</span>
                  <span style={{ display: "block", marginTop: 2 }}>{item.body}</span>
                  <span style={{ display: "block", marginTop: 4, fontSize: "var(--fs-xs)", opacity: 0.6 }}>
                    {item.timeLabel}
                    {item.url ? " · Tap to open" : ""}
                  </span>
                </Tag>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
