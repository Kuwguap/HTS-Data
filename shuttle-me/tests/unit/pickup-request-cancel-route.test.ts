/**
 * POST /api/pickup-requests/[id]/cancel — withdrawing a request the driver had already
 * ACCEPTED tells that driver (pickup_request_cancelled, migrations 0012 + 0013) with the
 * same place wording as the create route; a pending or already cancelled request pushes
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireUser, notifyAndDrain } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
  notifyAndDrain: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireUser }));
vi.mock("@/lib/notify/enqueue", () => ({ notifyAndDrain }));

import { POST } from "@/app/api/pickup-requests/[id]/cancel/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const RIDER = "55555555-0000-4000-8000-000000000001";
const OTHER = "55555555-0000-4000-8000-000000000002";
const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const REQ = "99999999-0000-4000-8000-000000000001";
const LOC = "11111111-0000-4000-8000-000000000003";
const ctx = { params: Promise.resolve({ id: REQ }) };
const request = () => new Request(`http://localhost:3100/api/pickup-requests/${REQ}/cancel`, { method: "POST" });

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: REQ,
    rider_id: RIDER,
    status: "accepted",
    driver_id: DRIVER,
    pickup_location_id: LOC,
    custom_place: null,
    lat: null,
    lng: null,
    ...overrides,
  };
}

let db: ReturnType<typeof fakeAdmin>;

function setup(existing: Record<string, unknown>) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "pickup_requests" && call.op === "select") return { data: existing, error: null };
    if (call.table === "pickup_requests" && call.op === "update") return { data: { ...existing, ...(call.payload as object) }, error: null };
    if (call.table === "pickup_locations") return { data: { name: "KSB" }, error: null };
    return undefined;
  };
  db = fakeAdmin(respond);
  createAdminClient.mockReturnValue(db.client);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  requireUser.mockReset();
  requireUser.mockResolvedValue({ user: { id: RIDER }, profile: { id: RIDER, role: "student", is_active: true, full_name: "Abena Owusu" } });
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(1);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pickup-requests/[id]/cancel", () => {
  it("tells the accepting driver, with the pickup point's name and a per-request dedupe prefix", async () => {
    setup(row());
    const res = await POST(request(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({ id: REQ, status: "cancelled" });

    const update = db.calls.find((c) => c.table === "pickup_requests" && c.op === "update")!;
    expect(update.payload).toMatchObject({ status: "cancelled" });
    expect(filterOf(update, "eq", "rider_id")?.args[1]).toBe(RIDER);
    expect(filterOf(update, "in", "status")?.args[1]).toEqual(["pending", "accepted"]);

    expect(notifyAndDrain).toHaveBeenCalledTimes(1);
    expect(notifyAndDrain.mock.calls[0]![0]).toBe(db.client);
    expect(notifyAndDrain.mock.calls[0]![1]).toEqual({
      userIds: [DRIVER],
      kind: "pickup_request_cancelled",
      vars: { name: "Abena Owusu", pickup: "KSB", request_id: REQ },
      url: "/driver/requests",
      dedupePrefix: `pickup_request_cancelled:${REQ}`,
      ttlSeconds: 900,
      urgency: "high",
      collapseTag: `pr:${REQ}`,
    });
    // The push goes out after the status change, never before.
    const ops = db.calls.map((c) => `${c.op}:${c.table}`);
    expect(ops.indexOf("update:pickup_requests")).toBeLessThan(ops.indexOf("select:pickup_locations"));
  });

  it("falls back to the custom place, then to coordinates, like the create route", async () => {
    setup(row({ pickup_location_id: null, custom_place: "Tech junction" }));
    await POST(request(), ctx);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ vars: { pickup: "Tech junction" } });
    expect(db.calls.some((c) => c.table === "pickup_locations")).toBe(false);

    setup(row({ pickup_location_id: null, custom_place: null, lat: 6.6745, lng: -1.5716 }));
    await POST(request(), ctx);
    expect(notifyAndDrain.mock.calls[1]![1]).toMatchObject({ vars: { pickup: "6.67450, -1.57160" } });
  });

  it("pushes nothing when the request was still pending (no driver was waiting)", async () => {
    setup(row({ status: "pending", driver_id: null }));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(200);
    const update = db.calls.find((c) => c.table === "pickup_requests" && c.op === "update")!;
    expect(update.payload).toMatchObject({ status: "cancelled", responded_at: expect.any(String) });
    expect(Number.isNaN(Date.parse((update.payload as { responded_at: string }).responded_at))).toBe(false);
    expect(notifyAndDrain).not.toHaveBeenCalled();
  });

  it("pushes nothing when an accepted request has no driver on record", async () => {
    setup(row({ driver_id: null }));
    expect((await POST(request(), ctx)).status).toBe(200);
    expect(notifyAndDrain).not.toHaveBeenCalled();
  });

  it("is a no-op for an already cancelled request (no update, no push)", async () => {
    setup(row({ status: "cancelled" }));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(200);
    expect(db.calls.map((c) => `${c.op}:${c.table}`)).toEqual(["select:pickup_requests", "select:pickup_requests"]);
    expect(notifyAndDrain).not.toHaveBeenCalled();
  });

  it("409s for a request that can no longer be withdrawn (declined / expired / completed)", async () => {
    for (const status of ["declined", "expired", "completed"]) {
      setup(row({ status }));
      const res = await POST(request(), ctx);
      expect(res.status).toBe(409);
      expect(notifyAndDrain).not.toHaveBeenCalled();
    }
  });

  it("404s for another rider's request without telling anyone", async () => {
    setup(row({ rider_id: OTHER }));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(404);
    expect(notifyAndDrain).not.toHaveBeenCalled();
    expect(db.calls.filter((c) => c.op === "update")).toEqual([]);
  });
});
