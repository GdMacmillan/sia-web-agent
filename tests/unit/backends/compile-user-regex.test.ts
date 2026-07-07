import { describe, it, expect } from "@jest/globals";
import { compileUserRegex } from "../../../src/backends/utils.js";

describe("compileUserRegex (ReDoS guard)", () => {
  it("compiles a normal pattern", () => {
    const r = compileUserRegex("foo.*bar");
    expect(r).toBeInstanceOf(RegExp);
    expect((r as RegExp).test("fooXbar")).toBe(true);
  });

  it("allows reasonable bounded repetitions", () => {
    expect(compileUserRegex("\\d{1,100}")).toBeInstanceOf(RegExp);
    expect(compileUserRegex("[a-z]+@[a-z]+")).toBeInstanceOf(RegExp);
  });

  it("rejects a catastrophic nested-quantifier pattern (ReDoS)", () => {
    const r = compileUserRegex("(a+)+$");
    expect(r).not.toBeInstanceOf(RegExp);
    expect((r as { error: string }).error).toMatch(/catastrophic|ReDoS/i);
  });

  it("rejects an over-long pattern", () => {
    const r = compileUserRegex("a".repeat(1001));
    expect(r).not.toBeInstanceOf(RegExp);
    expect((r as { error: string }).error).toMatch(/too long/);
  });

  it("returns an error (never throws) for a malformed regex", () => {
    const r = compileUserRegex("(unclosed");
    expect(r).not.toBeInstanceOf(RegExp);
    expect((r as { error: string }).error).toMatch(/Invalid regex/);
  });
});
