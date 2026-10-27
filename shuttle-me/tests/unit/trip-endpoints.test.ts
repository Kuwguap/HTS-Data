import { describe, expect, it } from "vitest";
import { tripDestination } from "@/lib/trips/endpoints";

const HOSTEL = { lat: 6.6902, lng: -1.5611 };
const CAMPUS = { lat: 6.6745, lng: -1.5716 };

const none = { hostel_lat: null, hostel_lng: null, campus_lat: null, campus_lng: null };
const both = { hostel_lat: HOSTEL.lat, hostel_lng: HOSTEL.lng, campus_lat: CAMPUS.lat, campus_lng: CAMPUS.lng };

const stop = (direction: "to_campus" | "to_hostel" | null, lat: number, lng: number, is_active = true) => ({ direction, lat, lng, is_active });
const stops = [
  stop("to_campus", 6.6900, -1.5600), // hostel gate
  stop("to_campus", 6.6905, -1.5605), // hostel car park
  stop("to_hostel", 6.6690, -1.5650), // KSB (on campus)
  stop("to_hostel", 6.6700, -1.5660), // Commercial Area
];

describe("tripDestination", () => {
  it("uses the settings coordinates when both halves of the pair are set", () => {
    expect(tripDestination({ direction: "to_campus" }, both, stops)).toEqual(CAMPUS);
    expect(tripDestination({ direction: "to_hostel" }, both, stops)).toEqual(HOSTEL);
  });

  it("falls back to the first active pickup point on the far side", () => {
    // to_campus → the to_hostel stops stand on campus; to_hostel → the to_campus stops stand at the hostel.
    expect(tripDestination({ direction: "to_campus" }, none, stops)).toEqual({ lat: 6.669, lng: -1.565 });
    expect(tripDestination({ direction: "to_hostel" }, none, stops)).toEqual({ lat: 6.69, lng: -1.56 });
  });

  it("skips hidden stops and stops that serve both directions", () => {
    const list = [stop(null, 1, 1), stop("to_hostel", 2, 2, false), stop("to_hostel", 3, 3)];
    expect(tripDestination({ direction: "to_campus" }, none, list)).toEqual({ lat: 3, lng: 3 });
  });

  it("treats a half-set pair as unknown", () => {
    const half = { ...none, campus_lat: CAMPUS.lat };
    expect(tripDestination({ direction: "to_campus" }, half, stops)).toEqual({ lat: 6.669, lng: -1.565 });
  });

  it("is null when nothing is known", () => {
    expect(tripDestination({ direction: "to_campus" }, none, [])).toBeNull();
    expect(tripDestination({ direction: "to_hostel" }, none, [stop("to_hostel", 1, 1)])).toBeNull();
  });
});
