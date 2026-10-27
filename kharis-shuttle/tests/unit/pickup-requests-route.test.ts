/**
 * POST /api/pickup-requests — a pending request whose expires_at already passed (the
 * tick has not run yet) must not block a new one: the route expires the caller's stale
 * rows (same kind / vars / dedupe prefix as run_tick) BEFORE inserting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireUser, notifyAndDrain, listDriverIds } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
  notifyAndDrain: vi.fn(),
  listDriverIds: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireUser }));
vi.mock("@/lib/notify/enqueue", () => ({ notifyAndDrain, listDriverIds }));
vi.mock("@/lib/data/student", () => ({ listMyPickupRequests: vi.fn(async () => []) }));
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({ timezone: "Africa/Accra", default_driver_id: null })),
}));

import { POST } from "@/app/api/pickup-requests/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const RIDER = "55555555-0000-4000-8000-000000000001";
const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const STALE = "99999999-0000-4000-8000-000000000001";
const CREATED = "99999999-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({}) };

function post(body: Record<string, unknown>) {
  return new Request("http://localhost:3100/api/pickup-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "to_hostel", custom_place: "Tech junction", ...body }),
  });
}

function respond(stale: Array<{ id: string; pickup_location_id: string | null; custom_place: string | null }>) {
  return (call: FakeCall): FakeResult | undefined => {
    if (call.table === "pickup_requests" && call.op === "update") {
      return { data: stale.map((r) => ({ ...r, rider_id: RIDER })), error: null };
    }
    if (call.table === "pickup_requests" && call.op === "select") return { data: null, error: null }; // no live pending request
    if (call.table === "pickup_requests" && call.op === "insert") {
      const row = call.payload as Record<string, unknown>;
      return { data: { id: CREATED, ...row, note: row.note ?? null, created_at: new Date(NOW).toISOString() }, error: null };
    }
    if (call.table === "pickup_locations") return { data: { name: "KSB" }, error: null };
    return undefined;
  };
}

let db: ReturnType<typeof fakeAdmin>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  requireUser.mockReset();
  requireUser.mockResolvedValue({ user: { id: RIDER }, profile: { id: RIDER, role: "student", is_active: true, full_name: "Abena Owusu" } });
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(1);
  listDriverIds.mockReset();
  listDriverIds.mockResolvedValue([DRIVER]);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pickup-requests", () => {
  it("expires the caller's stale pending request before inserting, with the tick's own expiry notification", async () => {
    db = fakeAdmin(respond([{ id: STALE, pickup_location_id: null, custom_place: "Old corner" }]));
    createAdminClient.mockReturnValue(db.client);

    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).request.id).toBe(CREATED);

    const ops = db.calls.map((c) => `${c.op}:${c.table}`);
    expect(ops.indexOf("update:pickup_requests")).toBeLessThan(ops.indexOf("insert:pickup_requests"));
    expect(ops.indexOf("update:pickup_requests")).toBeLessThan(ops.indexOf("select:pickup_requests"));

    const expire = db.calls.find((c) => c.table === "pickup_requests" && c.op === "update")!;
    expect(expire.payload).toEqual({ status: "expired" });
    expect(filterOf(expire, "eq", "rider_id")?.args[1]).toBe(RIDER);
    expect(filterOf(expire, "eq", "status")?.args[1]).toBe("pending");
    expect(filterOf(expire, "lte", "expires_at")?.args[1]).toBe(new Date(NOW).toISOString());
    expect(expire.columns).toContain("pickup_location_id");

    // Same kind, vars, url and dedupe prefix as run_tick (0005) → the tick cannot double-send.
    expect(notifyAndDrain).toHaveBeenCalledTimes(2);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({
      userIds: [RIDER],
      kind: "pickup_request_expired",
      vars: { pickup: "Old corner", request_id: STALE },
      url: `/app/requests/${STALE}`,
      dedupePrefix: `pr_expired:${STALE}`,
      collapseTag: `request:${STALE}`,
    });
    expect(notifyAndDrain.mock.calls[1]![1]).toMatchObject({ kind: "pickup_request_new", dedupePrefix: `pickup_request_new:${CREATED}` });
  });

  it("resolves the stale request's pickup point name like the tick does", async () => {
    db = fakeAdmin(respond([{ id: STALE, pickup_location_id: "11111111-0000-4000-8000-000000000003", custom_place: null }]));
    createAdminClient.mockReturnValue(db.client);
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ kind: "pickup_request_expired", vars: { pickup: "KSB" } });
  });

  it("sends no expiry notification when nothing was stale", async () => {
    db = fakeAdmin(respond([]));
    createAdminClient.mockReturnValue(db.client);
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect(notifyAndDrain).toHaveBeenCalledTimes(1);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ kind: "pickup_request_new" });
  });

  it("still inserts when the expiry update fails (the unique index remains the backstop)", async () => {
    db = fakeAdmin((call) =>
      call.table === "pickup_requests" && call.op === "update" ? { data: null, error: { message: "boom" } } : respond([])(call),
    );
    createAdminClient.mockReturnValue(db.client);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    expect(db.calls.map((c) => `${c.op}:${c.table}`)).toContain("insert:pickup_requests");
  });
});
