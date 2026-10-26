"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, Field, FilterPills, Sheet, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { renderTemplate } from "@/lib/data/template-defaults";

type Audience = "students" | "drivers" | "all";
type Props = { counts: Record<Audience, number>; template: { title: string; body: string }; hostelName: string };
type Result = { recipients: number; enqueued: number; sent: number; skipped: number; failed: number; requeued: number };

export function BroadcastForm({ counts, template, hostelName }: Props) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<Audience>("students");
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [last, setLast] = useState<Result | null>(null);

  const n = counts[audience];
  const vars = { title, message, hostel: hostelName };

  function review(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    if (!title.trim() || !message.trim()) {
      setErrors({ title: title.trim() ? undefined : "Add a title", message: message.trim() ? undefined : "Add a message" });
      return;
    }
    setConfirm(true);
  }

  async function send() {
    setBusy(true);
    try {
      const res = await api.post<Result>("/api/admin/broadcast", { title, message, audience, url: url || null });
      setLast(res);
      setConfirm(false);
      toast(`📣 Sent to ${res.sent} · ${res.skipped} without a device${res.failed ? ` · ${res.failed} failed` : ""}`, { tone: "green", ms: 5000 });
      setTitle("");
      setMessage("");
      setUrl("");
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({ title: err.fieldError("title"), message: err.fieldError("message"), url: err.fieldError("url") });
        setConfirm(false);
      }
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={review} className="flex flex-col gap-4">
        <div>
          <span className="k-label">Send to</span>
          <FilterPills
            aria-label="Audience"
            value={audience}
            onChange={setAudience}
            options={[
              { value: "students", label: "Students", count: counts.students },
              { value: "drivers", label: "Drivers", count: counts.drivers },
              { value: "all", label: "Everyone", count: counts.all },
            ]}
          />
        </div>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} placeholder="No shuttle this afternoon" maxLength={80} required />
        <Field as="textarea" label="Message" value={message} onChange={(e) => setMessage(e.target.value)} error={errors.message} placeholder="The bus is being serviced. The 3:30 PM trip is cancelled; 6:30 PM runs as normal." maxLength={400} rows={4} required />
        <Field label="Link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} error={errors.url} placeholder="/app" help="A page in the app to open when tapped, e.g. /app or /app/inbox." maxLength={200} />
        <div>
          <span className="k-label">Preview</span>
          <Card>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{renderTemplate(template.title, vars) || "📣 Title"}</div>
            <div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 4 }}>{renderTemplate(template.body, vars) || "Your message"}</div>
          </Card>
        </div>
        <Button size="big" type="submit" disabled={n === 0}>
          📣 Send to {n} {n === 1 ? "person" : "people"}
        </Button>
        {last ? (
          <p className="k-help" style={{ textAlign: "center" }}>
            Last send: {last.recipients} recipients · {last.sent} pushed · {last.skipped} without a device · {last.requeued} retrying.
          </p>
        ) : null}
      </form>

      <Sheet
        open={confirm}
        onClose={() => (busy ? undefined : setConfirm(false))}
        title={`Send to ${n} ${n === 1 ? "person" : "people"}?`}
        footer={
          <div className="flex flex-col gap-2">
            <Button size="big" loading={busy} onClick={send}>
              📣 Yes, send now
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              Not yet
            </Button>
          </div>
        }
      >
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{renderTemplate(template.title, vars)}</div>
          <div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 4 }}>{renderTemplate(template.body, vars)}</div>
        </Card>
        <p className="k-help">It also lands in their inbox. You can&apos;t unsend a push.</p>
      </Sheet>
    </>
  );
}
