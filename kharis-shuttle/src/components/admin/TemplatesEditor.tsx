"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, Field, List, Pill, Row, Sheet, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { MessageTemplate } from "@/lib/db.types";
import { renderTemplate, TEMPLATE_DEFAULTS, TEMPLATE_META, TEMPLATE_SAMPLE_VARS } from "@/lib/data/template-defaults";

type TemplateRow = MessageTemplate & { is_default: boolean };
type Props = { templates: TemplateRow[]; hostelName: string; campusName: string };

export function TemplatesEditor({ templates, hostelName, campusName }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);

  const sample = { ...TEMPLATE_SAMPLE_VARS, hostel: hostelName, campus: campusName, destination: campusName };

  const open = (t: TemplateRow) => {
    setEditing(t);
    setTitle(t.title);
    setBody(t.body);
    setErrors({});
  };
  const close = () => setEditing(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setErrors({});
    try {
      await api.put(`/api/admin/templates/${editing.key}`, { title, body });
      toast("✅ Template saved", { tone: "green" });
      close();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setErrors({ title: err.fieldError("title"), body: err.fieldError("body") });
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  const restore = () => {
    if (!editing) return;
    const def = TEMPLATE_DEFAULTS[editing.key];
    setTitle(def.title);
    setBody(def.body);
  };

  const insert = (key: string) => setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}{${key}}`);

  const groups: Array<{ caption: string; keys: TemplateRow["key"][] }> = [
    { caption: "Students · daily", keys: ["daily_announcement", "trip_reminder", "trip_nudge", "trip_departed"] },
    { caption: "Students · bookings", keys: ["booking_confirmed", "booking_waitlisted", "booking_promoted", "booking_cancelled", "trip_cancelled", "trip_updated"] },
    { caption: "Pickup requests", keys: ["pickup_request_new", "pickup_request_accepted", "pickup_request_declined", "pickup_request_expired", "pickup_request_cancelled"] },
    { caption: "Drivers & admin", keys: ["driver_manifest", "driver_booking_update", "return_announcement", "broadcast", "test"] },
  ];
  const byKey = new Map(templates.map((t) => [t.key, t]));

  return (
    <>
      {groups.map((g) => (
        <List key={g.caption} caption={g.caption}>
          {g.keys.map((key) => {
            const t = byKey.get(key);
            if (!t) return null;
            const meta = TEMPLATE_META[key];
            return (
              <Row
                key={key}
                title={meta.label}
                subtitle={renderTemplate(t.title, sample)}
                trailing={t.is_default ? undefined : <Pill tone="blue" sm>Edited</Pill>}
                onClick={() => open(t)}
                chevron
              />
            );
          })}
        </List>
      ))}
      <p className="k-help" style={{ textAlign: "center" }}>
        Placeholders like {"{time}"} are filled in when the message is sent. Unknown ones render as nothing.
      </p>

      <Sheet
        open={editing !== null}
        onClose={close}
        title={editing ? TEMPLATE_META[editing.key].label : ""}
        footer={
          <div className="flex flex-col gap-2">
            <Button size="big" type="submit" form="template-form" loading={busy}>
              ✅ Save template
            </Button>
            <Button variant="ghost" onClick={restore} disabled={busy}>
              ↩️ Restore default
            </Button>
          </div>
        }
      >
        {editing ? (
          <form id="template-form" onSubmit={save} className="flex flex-col gap-4">
            <p className="k-help" style={{ margin: 0 }}>
              Sent: {TEMPLATE_META[editing.key].when}.
            </p>
            <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={120} required />
            <Field as="textarea" label="Message" value={body} onChange={(e) => setBody(e.target.value)} error={errors.body} maxLength={500} rows={4} required />
            <div>
              <span className="k-label">Placeholders · tap to insert</span>
              <div className="flex flex-wrap gap-2">
                {TEMPLATE_META[editing.key].placeholders.map((p) => (
                  <button key={p} type="button" className="k-pill k-pill--blue" onClick={() => insert(p)} style={{ minHeight: 32 }}>
                    {`{${p}}`}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="k-label">Preview</span>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{renderTemplate(title, sample) || "(empty title)"}</div>
                <div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 4 }}>{renderTemplate(body, sample) || "(empty message)"}</div>
              </Card>
            </div>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}
