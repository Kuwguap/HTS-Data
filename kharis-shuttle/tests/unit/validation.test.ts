import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema, changePinSchema, updateProfileSchema } from "@/lib/validation/auth";
import { createBookingSchema, createPickupRequestSchema, respondPickupRequestSchema } from "@/lib/validation/bookings";
import { announceTripSchema, locationBatchSchema } from "@/lib/validation/driver";
import { pushSubscribeSchema } from "@/lib/validation/push";
import { broadcastSchema, settingsPatchSchema } from "@/lib/validation/admin";

const UUID = "11111111-0000-4000-8000-000000000001";

function fieldErrors(result: { success: boolean; error?: { flatten(): { fieldErrors: Record<string, string[] | undefined> } } }) {
  return result.success ? {} : result.error!.flatten().fieldErrors;
}

describe("registerSchema", () => {
  it("accepts a good registration and normalises the username", () => {
    const r = registerSchema.safeParse({
      username: " Abena_01 ",
      full_name: " Abena Mensah ",
      pin: "1234",
      phone: "",
      room: "B12",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.username).toBe("abena_01");
      expect(r.data.full_name).toBe("Abena Mensah");
      expect(r.data.phone).toBeNull();
      expect(r.data.room).toBe("B12");
      // Omitted optional text stays omitted (PATCH bodies must not null other columns).
      expect(r.data.signup_code).toBeUndefined();
      expect("signup_code" in r.data).toBe(false);
    }
  });
  it("optionalText leaves omitted keys out of PATCH bodies (reminders switch must not erase phone/room)", () => {
    const r = updateProfileSchema.parse({ reminders_enabled: true });
    expect(Object.keys(r)).toEqual(["reminders_enabled"]);
    const cleared = updateProfileSchema.parse({ phone: "", room: null });
    expect(cleared.phone).toBeNull();
    expect(cleared.room).toBeNull();
  });
  it("rejects bad usernames, names and PINs", () => {
    const r = registerSchema.safeParse({ username: "ab", full_name: "A", pin: "12" });
    expect(r.success).toBe(false);
    const errors = fieldErrors(r);
    expect(errors.username?.[0]).toMatch(/3–20/);
    expect(errors.full_name?.[0]).toMatch(/full name/i);
    expect(errors.pin?.[0]).toMatch(/4–6 digits/);
  });
  it("rejects a username with spaces or symbols even after trimming", () => {
    expect(registerSchema.safeParse({ username: "kwa me", full_name: "Kwame", pin: "1234" }).success).toBe(false);
    expect(registerSchema.safeParse({ username: "kwame!", full_name: "Kwame", pin: "1234" }).success).toBe(false);
  });
});

describe("loginSchema / changePinSchema", () => {
  it("accepts and rejects", () => {
    expect(loginSchema.safeParse({ username: "Kwame", pin: "123456" }).success).toBe(true);
    expect(loginSchema.safeParse({ username: "kwame", pin: "12345678" }).success).toBe(false);
    expect(loginSchema.safeParse({ username: "kwame" }).success).toBe(false);
    expect(changePinSchema.safeParse({ current_pin: "1234", new_pin: "5678" }).success).toBe(true);
    expect(changePinSchema.safeParse({ current_pin: "1234", new_pin: "abcd" }).success).toBe(false);
  });
});

describe("createBookingSchema", () => {
  it("accepts a booking with the cash agreement", () => {
    const r = createBookingSchema.safeParse({ trip_id: UUID, pickup_location_id: UUID, pickup_note: "", agreed_cash: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pickup_note).toBeNull();
      expect(r.data.agreed_cash).toBe(true);
    }
  });
  it("requires agreed_cash to be literally true", () => {
    const missing = createBookingSchema.safeParse({ trip_id: UUID });
    expect(missing.success).toBe(false);
    expect(fieldErrors(missing).agreed_cash?.[0]).toMatch(/cash/i);
    expect(createBookingSchema.safeParse({ trip_id: UUID, agreed_cash: false }).success).toBe(false);
    expect(createBookingSchema.safeParse({ trip_id: UUID, agreed_cash: "true" }).success).toBe(false);
  });
  it("rejects a non-uuid trip id", () => {
    expect(createBookingSchema.safeParse({ trip_id: "123", agreed_cash: true }).success).toBe(false);
  });
});

describe("createPickupRequestSchema", () => {
  it("needs a place, a custom place or coordinates", () => {
    expect(createPickupRequestSchema.safeParse({ direction: "to_campus" }).success).toBe(false);
    expect(createPickupRequestSchema.safeParse({ direction: "to_campus", pickup_location_id: UUID }).success).toBe(true);
    expect(createPickupRequestSchema.safeParse({ direction: "to_hostel", custom_place: "Tech junction" }).success).toBe(true);
    expect(createPickupRequestSchema.safeParse({ direction: "to_hostel", lat: 6.68, lng: -1.57 }).success).toBe(true);
    expect(createPickupRequestSchema.safeParse({ direction: "to_hostel", lat: 6.68 }).success).toBe(false);
  });
  it("respond accepts accept/decline only", () => {
    expect(respondPickupRequestSchema.safeParse({ action: "accept" }).success).toBe(true);
    expect(respondPickupRequestSchema.safeParse({ action: "maybe" }).success).toBe(false);
  });
});

describe("locationBatchSchema", () => {
  const point = { lat: 6.68, lng: -1.57, accuracy: 12, heading: 90, speed: 6.5, at: "2026-10-27T07:30:00.000Z" };
  it("accepts 1–50 points with ISO timestamps", () => {
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [point] }).success).toBe(true);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: Array(50).fill(point) }).success).toBe(true);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [{ ...point, at: "2026-10-27T07:30:00+01:00" }] }).success).toBe(true);
  });
  it("rejects empty batches, too many points, bad coordinates and bad timestamps", () => {
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [] }).success).toBe(false);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: Array(51).fill(point) }).success).toBe(false);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [{ ...point, lat: 91 }] }).success).toBe(false);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [{ ...point, at: "yesterday" }] }).success).toBe(false);
    expect(locationBatchSchema.safeParse({ trip_id: UUID, points: [{ ...point, heading: 361 }] }).success).toBe(false);
  });
});

describe("announceTripSchema", () => {
  it("fills defaults", () => {
    const r = announceTripSchema.safeParse({ origin_label: "KSB" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.direction).toBe("to_hostel");
      expect(r.data.leaving_in_minutes).toBe(10);
      expect(r.data.message).toBeUndefined();
    }
  });
  it("requires an origin and bounds the lead time", () => {
    expect(fieldErrors(announceTripSchema.safeParse({ origin_label: "  " })).origin_label?.[0]).toMatch(/where/i);
    expect(announceTripSchema.safeParse({ origin_label: "KSB", leaving_in_minutes: 500 }).success).toBe(false);
    expect(announceTripSchema.safeParse({ origin_label: "KSB", seat_capacity: 0 }).success).toBe(false);
  });
});

describe("pushSubscribeSchema", () => {
  it("accepts a PushSubscription.toJSON() shape", () => {
    expect(
      pushSubscribeSchema.safeParse({
        endpoint: "https://web.push.apple.com/abc",
        keys: { p256dh: "BPUBLICKEYPUBLICKEY", auth: "AUTHSECRET" },
        expirationTime: null,
        platform: "ios",
      }).success,
    ).toBe(true);
  });
  it("rejects non-https endpoints and missing keys", () => {
    expect(pushSubscribeSchema.safeParse({ endpoint: "not a url", keys: { p256dh: "x".repeat(20), auth: "y".repeat(10) } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "short" } }).success).toBe(false);
  });
});

describe("admin schemas", () => {
  it("broadcast defaults to students", () => {
    const r = broadcastSchema.safeParse({ title: "Notice", message: "No shuttle on Friday" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.audience).toBe("students");
    expect(broadcastSchema.safeParse({ title: "", message: "x" }).success).toBe(false);
  });
  it("settings patch validates the time of day and ranges", () => {
    expect(settingsPatchSchema.safeParse({ daily_announcement_time: "06:00" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ daily_announcement_time: "6am" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ reminder_lead_minutes: 1 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ fare_pesewas: 1000 }).success).toBe(true);
  });
});
