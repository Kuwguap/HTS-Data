"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Art, Button, Empty, Field, List, Pill, Row, Sheet, Skeleton, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { PickupLocation, TripDirection } from "@/lib/db.types";
import { preloadBasemap } from "@/lib/map/basemap";
import type { PickerPlace } from "./LocationPicker";

const LocationPicker = dynamic(() => import("./LocationPicker"), { ssr: false, loading: () => <Skeleton lines={1} height={220} widths={["100%"]} /> });

/** Hostel / campus from settings, when their coordinates are set. */
export type Destination = { name: string; lat: number; lng: number };

type Props = { locations: PickupLocation[]; campusName: string; hostelName: string; destinations: Destination[] };

type Form = { name: string; description: string; direction: TripDirection | ""; lat: string; lng: string; sort_order: string; is_active: boolean };

const EMPTY: Form = { name: "", description: "", direction: "", lat: "", lng: "", sort_order: "0", is_active: true };

function toForm(l: PickupLocation): Form {
  return {
    name: l.name,
    description: l.description ?? "",
    direction: l.direction ?? "",
    lat: String(l.lat),
    lng: String(l.lng),
    sort_order: String(l.sort_order),
    is_active: l.is_active,
  };
}

function num(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function LocationsEditor({ locations, campusName, hostelName, destinations }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<PickupLocation | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const dirLabel = (d: TripDirection | null) => (d === "to_campus" ? `To ${campusName}` : d === "to_hostel" ? `To ${hostelName}` : "Both directions");

  // The picker's basemap stack is ready by the time the admin taps ✏️.
  useEffect(() => preloadBasemap(), []);

  // Every other saved place, with its name, drawn on the picker map for context.
  const editingId = editing !== null && editing !== "new" ? editing.id : null;
  const places = useMemo<PickerPlace[]>(
    () => [
      ...locations
        .filter((l) => l.id !== editingId)
        .map((l): PickerPlace => ({ id: l.id, name: l.is_active ? l.name : `${l.name} · hidden`, lat: l.lat, lng: l.lng, kind: "pickup" })),
      ...destinations.map((d): PickerPlace => ({ ...d, kind: "destination" })),
    ],
    [locations, destinations, editingId],
  );

  const open = (l: PickupLocation | "new") => {
    setEditing(l);
    setForm(l === "new" ? EMPTY : toForm(l));
    setErrors({});
  };
  const close = () => setEditing(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const lat = num(form.lat);
    const lng = num(form.lng);
    if (lat == null || lng == null) {
      setErrors({ lat: lat == null ? "Tap the map or enter a latitude" : undefined, lng: lng == null ? "Enter a longitude" : undefined });
      return;
    }
    setBusy(true);
    setErrors({});
    const body = {
      name: form.name,
      description: form.description || null,
      direction: form.direction || null,
      lat,
      lng,
      sort_order: Number(form.sort_order) || 0,
      is_active: form.is_active,
    };
    try {
      if (editing === "new") await api.post("/api/admin/locations", body);
      else if (editing) await api.patch(`/api/admin/locations/${editing.id}`, body);
      toast(editing === "new" ? "✅ Pickup point added" : "✅ Pickup point saved", { tone: "green" });
      close();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({ name: err.fieldError("name"), description: err.fieldError("description"), lat: err.fieldError("lat"), lng: err.fieldError("lng"), sort_order: err.fieldError("sort_order") });
      }
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || editing === "new") return;
    if (!window.confirm(`Delete "${editing.name}"? If riders have used it, it is hidden instead so history stays intact.`)) return;
    setBusy(true);
    try {
      const res = await api.delete<{ deleted: boolean; deactivated: boolean }>(`/api/admin/locations/${editing.id}`);
      toast(res.deleted ? "🗑 Pickup point deleted" : "⏸ Pickup point hidden (it has bookings)");
      close();
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(l: PickupLocation, next: boolean) {
    setToggling(l.id);
    try {
      await api.patch(`/api/admin/locations/${l.id}`, { is_active: next });
      toast(next ? "✅ Pickup point shown" : "⏸ Pickup point hidden");
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setToggling(null);
    }
  }

  return (
    <>
      <List caption="Pickup points">
        {locations.length === 0 ? (
          <Empty art="pin" title="No pickup points yet" hint="Add the hostel gate and the campus stops." />
        ) : (
          locations.map((l) => (
            <Row
              key={l.id}
              leading={<Art k="pin" size={32} />}
              title={l.name}
              subtitle={`${dirLabel(l.direction)}${l.description ? ` · ${l.description}` : ""}`}
              trailing={
                <>
                  {!l.is_active ? (
                    <Pill sm>Hidden</Pill>
                  ) : null}
                  <Switch checked={l.is_active} disabled={toggling === l.id} onChange={(next) => toggleActive(l, next)} label={`${l.name} active`} />
                  <Button variant="ghost" size="sm" onClick={() => open(l)} aria-label={`Edit ${l.name}`}>
                    ✏️
                  </Button>
                </>
              }
              chevron={false}
            />
          ))
        )}
      </List>

      <Button size="big" onClick={() => open("new")}>
        ➕ Add pickup point
      </Button>

      <Sheet
        open={editing !== null}
        onClose={close}
        title={editing === "new" ? "New pickup point" : "Edit pickup point"}
        footer={
          <div className="flex flex-col gap-2">
            <Button size="big" type="submit" form="location-form" loading={busy}>
              {editing === "new" ? "➕ Add pickup point" : "✅ Save"}
            </Button>
            {editing && editing !== "new" ? (
              <Button variant="dangerSoft" onClick={remove} disabled={busy}>
                🗑 Delete
              </Button>
            ) : null}
          </div>
        }
      >
        <form id="location-form" onSubmit={save} className="flex flex-col gap-4">
          <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} placeholder="Hostel main gate" required maxLength={80} />
          <Field label="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} error={errors.description} placeholder="By the security post" maxLength={200} />
          <Field as="select" label="Direction" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Form["direction"] })}>
            <option value="">Both directions</option>
            <option value="to_campus">To {campusName}</option>
            <option value="to_hostel">To {hostelName}</option>
          </Field>
          {editing !== null ? (
            <LocationPicker
              lat={num(form.lat)}
              lng={num(form.lng)}
              onChange={(lat, lng) => setForm((f) => ({ ...f, lat: String(lat), lng: String(lng) }))}
              label={form.name.trim() || (editing === "new" ? "New pickup point" : editing.name)}
              places={places}
            />
          ) : null}
          <div className="k-grid-2">
            <Field label="Latitude" type="number" inputMode="decimal" step="any" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} error={errors.lat} placeholder="6.6760" />
            <Field label="Longitude" type="number" inputMode="decimal" step="any" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} error={errors.lng} placeholder="-1.5720" />
          </div>
          <Field label="Sort order" type="number" inputMode="numeric" min={0} max={1000} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} error={errors.sort_order} help="Lower numbers show first." />
          <List>
            <Row title="Shown to students" subtitle="Hidden points can't be picked for new bookings" trailing={<Switch checked={form.is_active} onChange={(is_active) => setForm({ ...form, is_active })} label="Shown to students" />} />
          </List>
        </form>
      </Sheet>
    </>
  );
}
