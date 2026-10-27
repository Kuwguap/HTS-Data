import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_EMAIL_DOMAIN,
  derivePassword,
  emailToUsername,
  isValidPin,
  isValidUsername,
  normalizeUsername,
  secretsEqual,
  usernameToEmail,
} from "@/lib/auth/pin";

const PEPPER = "a-very-long-pepper-value-for-tests-0123456789";

describe("derivePassword", () => {
  it("is deterministic", () => {
    expect(derivePassword("abena", "1234", PEPPER)).toBe(derivePassword("abena", "1234", PEPPER));
  });
  it("normalises the username before hashing", () => {
    expect(derivePassword("  Abena ", "1234", PEPPER)).toBe(derivePassword("abena", "1234", PEPPER));
  });
  it("differs per username, pin and pepper", () => {
    const base = derivePassword("abena", "1234", PEPPER);
    expect(derivePassword("yaw", "1234", PEPPER)).not.toBe(base);
    expect(derivePassword("abena", "1235", PEPPER)).not.toBe(base);
    expect(derivePassword("abena", "1234", PEPPER + "x")).not.toBe(base);
  });
  it("is 43 chars of base64url (SHA-256 without padding)", () => {
    const out = derivePassword("abena", "1234", PEPPER);
    expect(out).toHaveLength(43);
    expect(out).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("rejects a short or empty pepper", () => {
    expect(() => derivePassword("abena", "1234", "short")).toThrow(/PIN_PEPPER/);
    expect(() => derivePassword("abena", "1234", "")).toThrow(/PIN_PEPPER/);
  });
});

describe("usernameToEmail / emailToUsername", () => {
  it("round-trips", () => {
    const email = usernameToEmail("kwame_01");
    expect(email).toBe(`kwame_01@${SYNTHETIC_EMAIL_DOMAIN}`);
    expect(emailToUsername(email)).toBe("kwame_01");
  });
  it("lower-cases and trims on the way in", () => {
    expect(usernameToEmail(" Kwame ")).toBe(`kwame@${SYNTHETIC_EMAIL_DOMAIN}`);
  });
  it("rejects emails that are not ours", () => {
    expect(emailToUsername("kwame@gmail.com")).toBeNull();
    expect(emailToUsername("@users.shuttle-me.local")).toBeNull();
    expect(emailToUsername("")).toBeNull();
    expect(emailToUsername(null)).toBeNull();
    expect(emailToUsername(undefined)).toBeNull();
  });
});

describe("username / pin validation", () => {
  it("accepts 3–20 lowercase letters, digits and underscores", () => {
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("kwame_01")).toBe(true);
    expect(isValidUsername("a".repeat(20))).toBe(true);
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("a".repeat(21))).toBe(false);
    expect(isValidUsername("Kwame")).toBe(false);
    expect(isValidUsername("kwa me")).toBe(false);
    expect(isValidUsername("kwame-01")).toBe(false);
  });
  it("accepts 4–6 digit PINs only", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });
  it("normalizeUsername trims and lower-cases", () => {
    expect(normalizeUsername("  KwAme ")).toBe("kwame");
  });
});

describe("secretsEqual", () => {
  it("is true only for identical strings", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual("", "a")).toBe(false);
  });
  it("handles multi-byte strings", () => {
    expect(secretsEqual("GH₵10", "GH₵10")).toBe(true);
    expect(secretsEqual("GH₵10", "GH¢10")).toBe(false);
  });
});
