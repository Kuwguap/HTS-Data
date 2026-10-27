import { describe, expect, it } from "vitest";
import { BUILD_CHECK_INTERVAL_MS, isRealCommit, shouldCheckBuild, shouldReloadForBuild } from "@/lib/pwa/build-check";

const T0 = Date.parse("2026-10-27T08:00:00Z");

describe("shouldReloadForBuild", () => {
  it("reloads only when both commits are real and differ", () => {
    expect(shouldReloadForBuild("abc1234", "def5678", null, T0)).toBe(true);
    expect(shouldReloadForBuild("abc1234", "abc1234", null, T0)).toBe(false);
    expect(shouldReloadForBuild(null, "def5678", null, T0)).toBe(false);
    expect(shouldReloadForBuild("abc1234", null, null, T0)).toBe(false);
    expect(shouldReloadForBuild(undefined, undefined, null, T0)).toBe(false);
    expect(shouldReloadForBuild("", "def5678", null, T0)).toBe(false);
  });

  it("never reloads a dev build or against a server without a commit", () => {
    expect(shouldReloadForBuild("dev", "def5678", null, T0)).toBe(false);
    expect(shouldReloadForBuild("abc1234", "dev", null, T0)).toBe(false);
    expect(isRealCommit("dev")).toBe(false);
    expect(isRealCommit("abc1234")).toBe(true);
  });

  it("is throttled to once per 60 s from the previous check", () => {
    expect(shouldReloadForBuild("abc1234", "def5678", T0, T0 + 1_000)).toBe(false);
    expect(shouldReloadForBuild("abc1234", "def5678", T0, T0 + BUILD_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldReloadForBuild("abc1234", "def5678", T0, T0 + BUILD_CHECK_INTERVAL_MS)).toBe(true);
    expect(shouldCheckBuild(null, T0)).toBe(true);
    expect(shouldCheckBuild(T0, T0 + 59_999)).toBe(false);
    expect(shouldCheckBuild(T0, T0 + 60_000)).toBe(true);
  });
});
