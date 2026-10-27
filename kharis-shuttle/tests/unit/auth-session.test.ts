/**
 * Sign-in error mapping + lockout helpers from @/lib/auth/session.
 * The module is server-only and touches env/cookies at call time, not import time,
 * so those modules are stubbed and only the pure helpers are exercised here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  publicEnv: { supabaseUrl: "http://local.test", supabaseKey: "anon-key" },
  serverEnv: () => ({ pinPepper: "p".repeat(32) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("createClient must not be called by these tests");
  },
}));

import { ApiError } from "@/lib/api";
import { INVALID_CREDENTIALS_MESSAGE, WrongPinError, lockoutError, mapSignInError, reserveLoginAttempt } from "@/lib/auth/session";

describe("mapSignInError", () => {
  it("counts only a rejected username + PIN as a wrong PIN", () => {
    for (const e of [
      { name: "AuthApiError", status: 400, code: "invalid_credentials" },
      { name: "AuthApiError", status: 400 }, // old GoTrue: 400 with no code
    ]) {
      const mapped = mapSignInError(e);
      expect(mapped).toBeInstanceOf(WrongPinError);
      expect(mapped).toBeInstanceOf(ApiError);
      expect(mapped.status).toBe(401);
      expect(mapped.code).toBe("INVALID_CREDENTIALS");
      expect(mapped.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    }
  });
  it("maps the Supabase sign-in rate limit to 503 RATE_LIMITED", () => {
    for (const e of [
      { name: "AuthApiError", status: 429, code: "over_request_rate_limit" },
      { name: "AuthApiError", status: 429 },
      { name: "AuthApiError", status: 400, code: "over_request_rate_limit" },
    ]) {
      const mapped = mapSignInError(e);
      expect(mapped).not.toBeInstanceOf(WrongPinError);
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe("RATE_LIMITED");
      expect(mapped.message).toBe("Sign-in is busy right now. Try again in a minute.");
    }
  });
  it("maps outages (5xx, no status, retryable fetch errors) to 503 INTERNAL", () => {
    for (const e of [
      { name: "AuthRetryableFetchError", status: 0 },
      { name: "AuthApiError", status: 502, code: "unexpected_failure" },
      { name: "AuthUnknownError" },
      { name: "AuthApiError", status: 500 },
    ]) {
      const mapped = mapSignInError(e);
      expect(mapped).not.toBeInstanceOf(WrongPinError);
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe("INTERNAL");
      expect(mapped.message).toBe("Can't reach the sign-in service. Try again.");
    }
  });
  it("reports other auth codes as 401 without counting them", () => {
    for (const e of [
      { name: "AuthApiError", status: 400, code: "user_banned" },
      { name: "AuthApiError", status: 400, code: "email_not_confirmed" },
      { name: "AuthApiError", status: 403, code: "signup_disabled" },
    ]) {
      const mapped = mapSignInError(e);
      expect(mapped).toBeInstanceOf(ApiError);
      expect(mapped).not.toBeInstanceOf(WrongPinError);
      expect(mapped.status).toBe(401);
      expect(mapped.code).toBe("INVALID_CREDENTIALS");
      expect(mapped.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    }
  });
});

describe("lockoutError", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-27T07:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("is null when not locked or when the lock has expired", () => {
    expect(lockoutError(null)).toBeNull();
    expect(lockoutError(undefined)).toBeNull();
    expect(lockoutError("2026-10-27T06:59:59.000Z")).toBeNull();
    expect(lockoutError("2026-10-27T07:00:00.000Z")).toBeNull();
  });
  it("is a 423 LOCKED with the minutes left, rounded up and never below 1", () => {
    const e = lockoutError("2026-10-27T07:14:01.000Z");
    expect(e?.status).toBe(423);
    expect(e?.code).toBe("LOCKED");
    expect(e?.message).toBe("Too many wrong attempts. Try again in 15 min or ask the hostel office to reset your PIN.");
    expect(lockoutError("2026-10-27T07:00:05.000Z")?.message).toContain("in 1 min");
  });
});

describe("reserveLoginAttempt (count before verifying)", () => {
  const rpc = vi.fn();
  const admin = { rpc } as unknown as Parameters<typeof reserveLoginAttempt>[0];
  beforeEach(() => rpc.mockReset());

  it("counts the attempt atomically with one extra slot so 5 guesses are verified and the 6th is refused", async () => {
    const row = { username: "abena", failed_count: 2, locked_until: null, updated_at: "x" };
    rpc.mockResolvedValue({ data: row, error: null });
    await expect(reserveLoginAttempt(admin, " Abena ")).resolves.toEqual(row);
    expect(rpc).toHaveBeenCalledWith("record_login_failure", { p_username: "abena", p_max_failures: 6, p_lockout_minutes: 15 });
  });
  it("throws 423 LOCKED when the window is spent (this attempt tripped the lock or it was already locked)", async () => {
    rpc.mockResolvedValue({
      data: { username: "abena", failed_count: 0, locked_until: new Date(Date.now() + 15 * 60_000).toISOString(), updated_at: "x" },
      error: null,
    });
    await expect(reserveLoginAttempt(admin, "abena")).rejects.toMatchObject({ status: 423, code: "LOCKED" });
  });
  it("lets an expired lock through (the SQL side restarts the count)", async () => {
    rpc.mockResolvedValue({
      data: { username: "abena", failed_count: 1, locked_until: new Date(Date.now() - 1000).toISOString(), updated_at: "x" },
      error: null,
    });
    await expect(reserveLoginAttempt(admin, "abena")).resolves.toMatchObject({ failed_count: 1 });
  });
  it("fails closed with 503 when the counter cannot be written (logged)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
      await expect(reserveLoginAttempt(admin, "abena")).rejects.toMatchObject({ status: 503, code: "INTERNAL" });
      rpc.mockResolvedValue({ data: null, error: null });
      await expect(reserveLoginAttempt(admin, "abena")).rejects.toMatchObject({ status: 503 });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
});
