"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { PickupLocation, PickupRequest, Trip, TripDirection } from "@/lib/db.types";
import { formatTime } from "@/lib/time";
import { Art, Button, Caption, Card, Field, Row, SegmentedControl, useToast } from "@/components/ui";

const CUSTOM = "__custom__";

export type PickupRequestFormProps = {
  pickupLocations: PickupLocation[];
  /** Today's trips the rider may attach the request to (optional). */
  trips: Array<Pick<Trip, "id" | "departure_at" | "direction" | "status">>;
  defaultTripId?: string | null;
  defaultDirection?: TripDirection;
  timeZone: string;
};

type Geo = { lat: number; lng: number; accuracy: number | null };

/**
 * "Request a pickup": direction, optional departure, a place (pickup point,
 * somewhere else, or the phone's location) and a note. On success it replaces
 * the route with the request's status page.
 */
export function PickupRequestForm({ pickupLocations, trips, defaultTripId, defaultDirection, timeZone }: PickupRequestFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const defaultTrip = defaultTripId ? trips.find((t) => t.id === defaultTripId) : undefined;
  const [direction, setDirection] = useState<TripDirection>(defaultTrip?.direction ?? defaultDirection ?? "to_campus");
  const [tripId, setTripId] = useState<string>(defaultTrip?.id ?? "");
  const [place, setPlace] = useState<string>("");
  const [customPlace, setCustomPlace] = useState("");
  const [geo, setGeo] = useState<Geo | null>(null);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ place?: string; trip?: string; note?: string }>({});

  const places = useMemo(
    () => pickupLocations.filter((l) => l.is_active && (l.direction === null || l.direction === direction)),
    [pickupLocations, direction],
  );
  const tripOptions = useMemo(() => trips.filter((t) => t.direction === direction), [trips, direction]);
  const chosenPlace = place || places[0]?.id || CUSTOM;

  const changeDirection = (d: TripDirection) => {
    setDirection(d);
    setPlace("");
    if (!trips.some((t) => t.id === tripId && t.direction === d)) setTripId("");
  };

  const locate = () => {
    if (!("geolocation" in navigator)) {
      toast("⚠️ Location isn't available on this device", { tone: "red" });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null });
        setLocating(false);
        setErrors((e) => ({ ...e, place: undefined }));
      },
      (err) => {
        setLocating(false);
        toast(
          err.code === err.PERMISSION_DENIED
            ? "⚠️ Location is blocked — allow it in your settings or type the place"
            : "⚠️ Could not get your location — try again or type the place",
          { tone: "red" },
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  const submit = async () => {
    const isCustom = chosenPlace === CUSTOM;
    const next: typeof errors = {};
    if (isCustom && !customPlace.trim() && !geo) next.place = "Type the place or share your location.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const res = await api.post<{ request: PickupRequest }>("/api/pickup-requests", {
        trip_id: tripId || null,
        direction,
        pickup_location_id: isCustom ? null : chosenPlace,
        custom_place: isCustom ? customPlace.trim() || (geo ? "My location" : null) : null,
        lat: isCustom && geo ? geo.lat : null,
        lng: isCustom && geo ? geo.lng : null,
        note: note.trim() || null,
      });
      toast("✋ Request sent — waiting for the driver", { tone: "green" });
      router.replace(`/app/requests/${res.request.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "CONFLICT") {
          const existing = (err.details as { request_id?: string } | undefined)?.request_id;
          toast("ℹ️ You already have a request waiting", { tone: "amber" });
          if (existing) router.replace(`/app/requests/${existing}`);
          return;
        }
        if (err.code === "VALIDATION") {
          setErrors({
            place: err.fieldError("custom_place") ?? err.fieldError("pickup_location_id"),
            trip: err.fieldError("trip_id"),
            note: err.fieldError("note"),
          });
          return;
        }
        if (err.code === "PICKUP_INVALID") {
          setErrors({ place: err.message });
          return;
        }
        if (err.code === "TRIP_NOT_OPEN") {
          setErrors({ trip: err.message });
          return;
        }
      }
      toast(`⚠️ ${errorMessage(err, "Could not send the request — try again")}`, { tone: "red" });
    } finally {
      setBusy(false);
    }
  };

  const check = (on: boolean) => (
    <span className={["k-check", on ? "k-check--on" : ""].join(" ").trim()} aria-hidden="true">
      {on ? (
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path d="M2.5 7.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        aria-label="Direction"
        value={direction}
        onChange={changeDirection}
        options={[
          { value: "to_campus", label: "To campus" },
          { value: "to_hostel", label: "To hostel" },
        ]}
      />

      <Card>
        <Field as="select" label="Departure (optional)" value={tripId} onChange={(e) => setTripId(e.target.value)} error={errors.trip} help="Leave blank if any driver can come.">
          <option value="">Next available shuttle</option>
          {tripOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {formatTime(t.departure_at, timeZone)}
              {t.status === "boarding" ? " · boarding" : t.status === "departed" ? " · on the way" : ""}
            </option>
          ))}
        </Field>
      </Card>

      <div>
        <Caption>Where should the bus find you?</Caption>
        <div className="k-list" role="radiogroup" aria-label="Pickup place">
          {places.map((loc) => (
            <Row
              key={loc.id}
              selected={chosenPlace === loc.id}
              onClick={() => {
                setPlace(loc.id);
                setErrors((e) => ({ ...e, place: undefined }));
              }}
              leading={<Art k="pin" size={28} />}
              title={loc.name}
              subtitle={loc.description ?? undefined}
              trailing={check(chosenPlace === loc.id)}
            />
          ))}
          <Row
            selected={chosenPlace === CUSTOM}
            onClick={() => setPlace(CUSTOM)}
            leading={<Art k="compass" size={28} />}
            title="Somewhere else"
            subtitle="Describe the spot or share your location"
            trailing={check(chosenPlace === CUSTOM)}
          />
        </div>
        {chosenPlace === CUSTOM ? (
          <Card style={{ marginTop: 12 }}>
            <div className="flex flex-col gap-3">
              <Field
                label="Place"
                placeholder="e.g. Ayeduase junction, by the pharmacy"
                value={customPlace}
                maxLength={120}
                onChange={(e) => {
                  setCustomPlace(e.target.value);
                  if (e.target.value.trim()) setErrors((er) => ({ ...er, place: undefined }));
                }}
                error={errors.place}
              />
              <Button variant="secondary" onClick={locate} loading={locating}>
                📍 Use my location
              </Button>
              {geo ? (
                <p className="k-banner k-banner--green" style={{ margin: 0 }}>
                  <span aria-hidden="true">✅</span>
                  <span>
                    Location shared{geo.accuracy != null ? ` · accurate to about ${Math.round(geo.accuracy)} m` : ""}
                  </span>
                </p>
              ) : null}
            </div>
          </Card>
        ) : errors.place ? (
          <div className="k-error" role="alert">
            {errors.place}
          </div>
        ) : null}
      </div>

      <Card>
        <Field
          as="textarea"
          label="Note for the driver (optional)"
          placeholder="I'm in a yellow shirt, with two bags"
          value={note}
          maxLength={200}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />
      </Card>

      <Button size="big" onClick={submit} loading={busy}>
        ✋ Send pickup request
      </Button>
      <p style={{ margin: 0, textAlign: "center", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
        The driver gets a push right away and can accept or decline. Requests expire after 45 minutes.
      </p>
    </div>
  );
}
