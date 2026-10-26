import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatCountdown,
  formatDayLabel,
  formatDayTime,
  formatDays,
  formatFare,
  formatTime,
  isoWeekday,
  localDateString,
  zoneOffsetMs,
  zonedDateTime,
} from "@/lib/time";

const ACCRA = "Africa/Accra";
const LAGOS = "Africa/Lagos"; // UTC+1, no DST

describe("formatTime", () => {
  it("renders 07:30Z as 7:30 AM in Accra", () => {
    expect(formatTime("2026-10-27T07:30:00Z", ACCRA)).toBe("7:30 AM");
  });
  it("renders the afternoon with PM and no leading zero", () => {
    expect(formatTime("2026-10-27T13:30:00Z", ACCRA)).toBe("1:30 PM");
    expect(formatTime("2026-10-27T00:05:00Z", ACCRA)).toBe("12:05 AM");
  });
  it("shifts by the zone offset", () => {
    expect(formatTime("2026-10-27T07:30:00Z", LAGOS)).toBe("8:30 AM");
  });
});

describe("localDateString", () => {
  it("uses the zone's calendar date", () => {
    expect(localDateString("2026-10-27T23:30:00Z", ACCRA)).toBe("2026-10-27");
    expect(localDateString("2026-10-27T23:30:00Z", LAGOS)).toBe("2026-10-28");
  });
});

describe("formatDayLabel across the UTC midnight boundary (Lagos)", () => {
  // 23:30Z on the 27th is already 00:30 on the 28th in Lagos.
  const now = new Date("2026-10-27T23:30:00Z");
  it("Today / Tomorrow / Yesterday follow the local date", () => {
    expect(formatDayLabel("2026-10-28T10:00:00Z", now, LAGOS)).toBe("Today");
    expect(formatDayLabel("2026-10-29T10:00:00Z", now, LAGOS)).toBe("Tomorrow");
    expect(formatDayLabel("2026-10-27T10:00:00Z", now, LAGOS)).toBe("Yesterday");
  });
  it("the same instant is still the 27th in Accra", () => {
    expect(formatDayLabel("2026-10-27T10:00:00Z", now, ACCRA)).toBe("Today");
    expect(formatDayLabel("2026-10-28T10:00:00Z", now, ACCRA)).toBe("Tomorrow");
  });
  it("falls back to a short date further out", () => {
    expect(formatDayLabel("2026-11-02T10:00:00Z", now, ACCRA)).toBe("Mon 2 Nov");
  });
  it("formatDayTime combines label and time", () => {
    expect(formatDayTime("2026-10-27T07:30:00Z", now, ACCRA)).toBe("Today, 7:30 AM");
  });
});

describe("zonedDateTime", () => {
  it("builds the right instant for Accra (UTC+0) and Lagos (UTC+1)", () => {
    expect(zonedDateTime("2026-10-27", "07:30", ACCRA).toISOString()).toBe("2026-10-27T07:30:00.000Z");
    expect(zonedDateTime("2026-10-27", "07:30", LAGOS).toISOString()).toBe("2026-10-27T06:30:00.000Z");
  });
  it("accepts HH:MM:SS", () => {
    expect(zonedDateTime("2026-10-27", "07:30:15", ACCRA).toISOString()).toBe("2026-10-27T07:30:15.000Z");
  });
  it("zoneOffsetMs is 0 for Accra and +1h for Lagos", () => {
    const d = new Date("2026-10-27T12:00:00Z");
    expect(zoneOffsetMs(d, ACCRA)).toBe(0);
    expect(zoneOffsetMs(d, LAGOS)).toBe(3_600_000);
  });
  it("isoWeekday: 2026-10-27 is a Tuesday", () => {
    expect(isoWeekday("2026-10-27T12:00:00Z", ACCRA)).toBe(2);
    expect(isoWeekday("2026-11-01T12:00:00Z", ACCRA)).toBe(7);
  });
});

describe("formatDays", () => {
  it("names the common patterns", () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(formatDays([5, 4, 3, 2, 1, 1])).toBe("Mon–Fri");
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(formatDays([6, 7])).toBe("Weekends");
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDays([])).toBe("");
  });
});

describe("formatClock", () => {
  it("formats a bare time of day", () => {
    expect(formatClock("07:30:00")).toBe("7:30 AM");
    expect(formatClock("07:30")).toBe("7:30 AM");
    expect(formatClock("13:30")).toBe("1:30 PM");
    expect(formatClock("00:05")).toBe("12:05 AM");
    expect(formatClock("12:00")).toBe("12:00 PM");
  });
});

describe("formatFare", () => {
  it("drops the decimals for whole cedis and keeps two otherwise", () => {
    expect(formatFare(1000)).toBe("GH₵10");
    expect(formatFare(1250)).toBe("GH₵12.50");
    expect(formatFare(5)).toBe("GH₵0.05");
    expect(formatFare(0)).toBe("GH₵0");
  });
  it("prefixes other currencies with their code", () => {
    expect(formatFare(1000, "USD")).toBe("USD 10");
  });
});

describe("formatCountdown", () => {
  const now = new Date("2026-10-27T07:00:00Z");
  it("counts down in minutes and hours", () => {
    expect(formatCountdown("2026-10-27T07:12:00Z", now)).toBe("in 12 min");
    expect(formatCountdown("2026-10-27T09:05:00Z", now)).toBe("in 2 h 5 min");
    expect(formatCountdown("2026-10-27T09:00:00Z", now)).toBe("in 2 h");
  });
  it("says now at the minute and counts up afterwards", () => {
    expect(formatCountdown("2026-10-27T07:00:20Z", now)).toBe("now");
    expect(formatCountdown("2026-10-27T06:55:00Z", now)).toBe("5 min ago");
  });
});
