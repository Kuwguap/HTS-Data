/**
 * 0016_settings_coords.sql — the hostel / campus coordinates on settings: columns exist,
 * are nullable, range-checked like pickup_locations, and readable by signed-in users.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { IDS, as, errorOf, one, resetDb, rows } from "./helpers";

let c: Client;

beforeAll(async () => {
  c = await resetDb();
});

afterAll(async () => {
  await c?.end();
});

describe("settings coordinates (0016)", () => {
  it("adds four nullable double precision columns", async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(
      c,
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'settings'
          and column_name in ('hostel_lat', 'hostel_lng', 'campus_lat', 'campus_lng')
        order by column_name`,
    );
    expect(cols).toEqual([
      { column_name: "campus_lat", data_type: "double precision", is_nullable: "YES" },
      { column_name: "campus_lng", data_type: "double precision", is_nullable: "YES" },
      { column_name: "hostel_lat", data_type: "double precision", is_nullable: "YES" },
      { column_name: "hostel_lng", data_type: "double precision", is_nullable: "YES" },
    ]);
    const s = await one<{ hostel_lat: number | null; campus_lng: number | null }>(c, "select hostel_lat, campus_lng from settings where id = 1");
    expect(s).toEqual({ hostel_lat: null, campus_lng: null });
  });

  it("accepts real coordinates and clears them again", async () => {
    expect(await errorOf(c, "update settings set hostel_lat = 6.6902, hostel_lng = -1.5611, campus_lat = 6.6745, campus_lng = -1.5716 where id = 1")).toBe("");
    const s = await one<{ hostel_lat: number; hostel_lng: number; campus_lat: number; campus_lng: number }>(
      c,
      "select hostel_lat, hostel_lng, campus_lat, campus_lng from settings where id = 1",
    );
    expect(s).toEqual({ hostel_lat: 6.6902, hostel_lng: -1.5611, campus_lat: 6.6745, campus_lng: -1.5716 });
    expect(await errorOf(c, "update settings set hostel_lat = null, hostel_lng = null where id = 1")).toBe("");
  });

  it("rejects out-of-range values with the named check constraints", async () => {
    expect(await errorOf(c, "update settings set hostel_lat = 90.5 where id = 1")).toMatch(/settings_hostel_lat_range/);
    expect(await errorOf(c, "update settings set hostel_lat = -91 where id = 1")).toMatch(/settings_hostel_lat_range/);
    expect(await errorOf(c, "update settings set hostel_lng = 180.1 where id = 1")).toMatch(/settings_hostel_lng_range/);
    expect(await errorOf(c, "update settings set campus_lat = 91 where id = 1")).toMatch(/settings_campus_lat_range/);
    expect(await errorOf(c, "update settings set campus_lng = -181 where id = 1")).toMatch(/settings_campus_lng_range/);
    // the row is untouched after the failed statements
    const s = await one<{ campus_lat: number }>(c, "select campus_lat from settings where id = 1");
    expect(s.campus_lat).toBe(6.6745);
  });

  it("is readable by a signed-in student (column grant) but not writable", async () => {
    await as(c, { userId: IDS.s1 }, async (cx) => {
      expect(await errorOf(cx, "select hostel_lat, hostel_lng, campus_lat, campus_lng from settings")).toBe("");
      expect(await errorOf(cx, "update settings set campus_lat = 1 where id = 1")).toMatch(/permission denied/);
    });
  });
});
