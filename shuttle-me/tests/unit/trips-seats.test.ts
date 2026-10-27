import { describe, expect, it } from "vitest";
import { isWaitlistOnly } from "@/components/trips/seats";

describe("isWaitlistOnly", () => {
  it("is false while seats are free and nobody waits", () => {
    expect(isWaitlistOnly({ seat_capacity: 14, confirmed_count: 3, waitlist_count: 0 })).toBe(false);
  });
  it("is true when every seat is taken", () => {
    expect(isWaitlistOnly({ seat_capacity: 14, confirmed_count: 14, waitlist_count: 0 })).toBe(true);
    expect(isWaitlistOnly({ seat_capacity: 14, confirmed_count: 15, waitlist_count: 0 })).toBe(true);
  });
  it("is true when a seat is free but someone is already waiting (book_seat keeps the queue order)", () => {
    expect(isWaitlistOnly({ seat_capacity: 14, confirmed_count: 13, waitlist_count: 1 })).toBe(true);
  });
});
