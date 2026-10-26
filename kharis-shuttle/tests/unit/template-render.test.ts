import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATE_DEFAULTS, TEMPLATE_META, TEMPLATE_SAMPLE_VARS } from "@/lib/data/template-defaults";

/** Parity with SQL render_text (0004_fn_notify.sql): one pass, keep newlines, collapse runs of spaces/tabs, trim. */
describe("renderTemplate", () => {
  it("fills placeholders and stringifies numbers", () => {
    expect(renderTemplate("Shuttle at {time}: {seats_left}/{seats} left", { time: "7:30 AM", seats_left: 3, seats: 14 })).toBe(
      "Shuttle at 7:30 AM: 3/14 left",
    );
  });

  it("keeps the newline of a two-line template", () => {
    expect(renderTemplate("Line one {time}\nLine two {fare}", { time: "7:30 AM", fare: "GH₵10" })).toBe("Line one 7:30 AM\nLine two GH₵10");
  });

  it("does not re-expand a value that itself contains a placeholder (injection)", () => {
    expect(renderTemplate("Hi {name}: {message}", { name: "Ama", message: "see {other} and {name}" })).toBe("Hi Ama: see {other} and {name}");
  });

  it("renders unknown and null placeholders as nothing", () => {
    expect(renderTemplate("A {unknown} B {empty} C", { empty: null })).toBe("A B C");
  });

  it("collapses only runs of spaces/tabs, then trims", () => {
    expect(renderTemplate("  {a}\t\t{b}   end  \n", { a: "x", b: "" })).toBe("x end");
    expect(renderTemplate("x\n\n\ny", {})).toBe("x\n\n\ny");
  });

  it("leaves malformed braces alone", () => {
    expect(renderTemplate("{ not a key } {bad-key} {", { "not a key": "no" })).toBe("{ not a key } {bad-key} {");
  });
});

describe("TEMPLATE_META placeholders", () => {
  it("every chip has a sample value for the preview", () => {
    for (const [kind, meta] of Object.entries(TEMPLATE_META)) {
      for (const p of meta.placeholders) expect(TEMPLATE_SAMPLE_VARS[p], `${kind}.${p}`).toBeTruthy();
    }
  });

  it("every placeholder used by a default template is offered as a chip", () => {
    for (const [kind, def] of Object.entries(TEMPLATE_DEFAULTS)) {
      const used = [...`${def.title} ${def.body}`.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
      const chips = TEMPLATE_META[kind as keyof typeof TEMPLATE_META].placeholders;
      for (const key of used) expect(chips, `${kind} uses {${key}}`).toContain(key);
    }
  });
});
