import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, fromPostgresError, ok, parseBody, withHandler, type ApiErrorBody } from "@/lib/api";

describe("fromPostgresError", () => {
  it("maps the SQL function error codes to HTTP statuses and strips the prefix", () => {
    const e = fromPostgresError({ message: "TRIP_NOT_OPEN: This trip is not taking bookings", code: "P0001" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("TRIP_NOT_OPEN");
    expect(e.message).toBe("This trip is not taking bookings");

    expect(fromPostgresError({ message: "BOOKING_CLOSED" }).code).toBe("BOOKING_CLOSED");
    expect(fromPostgresError({ message: "ALREADY_BOOKED: You already have a seat" }).status).toBe(409);
    expect(fromPostgresError({ message: "PICKUP_INVALID: Pick a valid pickup point" }).code).toBe("PICKUP_INVALID");
    expect(fromPostgresError({ message: "NOT_FOUND: Trip not found" }).status).toBe(404);
    expect(fromPostgresError({ message: "FORBIDDEN: Not your booking" }).status).toBe(403);
  });
  it("maps unique violations to CONFLICT", () => {
    const e = fromPostgresError({ message: 'duplicate key value violates unique constraint "x"', code: "23505" });
    expect(e.status).toBe(409);
    expect(e.code).toBe("CONFLICT");
  });
  it("falls back to INTERNAL", () => {
    const e = fromPostgresError({ message: "connection refused" });
    expect(e.status).toBe(500);
    expect(e.code).toBe("INTERNAL");
    expect(fromPostgresError(null).message).toBe("Database error");
  });
});

describe("withHandler", () => {
  const ctx = { params: Promise.resolve({}) };
  it("passes successful responses through", async () => {
    const handler = withHandler(async () => ok({ hello: "world" }));
    const res = await handler(new Request("http://localhost/x"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });
  it("turns ApiError into a JSON error body with its status", async () => {
    const handler = withHandler(async () => {
      throw new ApiError(403, "FORBIDDEN", "You don't have access to this.", { why: "role" });
    });
    const res = await handler(new Request("http://localhost/x"), ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toEqual({ code: "FORBIDDEN", message: "You don't have access to this.", details: { why: "role" } });
  });
  it("turns a ZodError into 400 VALIDATION", async () => {
    const handler = withHandler(async () => {
      z.object({ a: z.number() }).parse({ a: "x" });
      return ok({});
    });
    const res = await handler(new Request("http://localhost/x"), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("VALIDATION");
  });
  it("hides unknown errors behind a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = withHandler(async () => {
      throw new Error("db exploded");
    });
    const res = await handler(new Request("http://localhost/x"), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("exploded");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("parseBody", () => {
  const schema = z.object({ username: z.string().min(3), pin: z.string().regex(/^\d{4,6}$/) });
  const req = (body: BodyInit) =>
    new Request("http://localhost/x", { method: "POST", body, headers: { "Content-Type": "application/json" } });

  it("returns the parsed data", async () => {
    await expect(parseBody(req(JSON.stringify({ username: "kwame", pin: "1234" })), schema)).resolves.toEqual({
      username: "kwame",
      pin: "1234",
    });
  });
  it("rejects non-JSON bodies", async () => {
    await expect(parseBody(req("not json"), schema)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION",
      message: "Body must be JSON",
    });
  });
  it("reports field errors in flatten() shape", async () => {
    const err = await parseBody(req(JSON.stringify({ username: "ab", pin: "x" })), schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const details = (err as ApiError).details as { fieldErrors: Record<string, string[]>; formErrors: string[] };
    expect(details.formErrors).toEqual([]);
    expect(Object.keys(details.fieldErrors).sort()).toEqual(["pin", "username"]);
    expect(details.fieldErrors.username?.length).toBeGreaterThan(0);
  });
});
