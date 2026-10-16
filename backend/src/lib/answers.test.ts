import { describe, expect, it } from "vitest";
import { hashAnswer, normalizeAnswer, sameHash } from "./answers";

const PEPPER = "p".repeat(48);

describe("answers", () => {
  it("normalizes case, spacing, punctuation and accents", () => {
    for (const v of ["Write it up", "WRITE-IT-UP", "  writeitup ", "wríte it úp!"]) expect(normalizeAnswer(v)).toBe("writeitup");
  });
  it("hashes are bound to the book and puzzle, and to the secret", () => {
    const h = hashAnswer(PEPPER, "s309-b1", "kcal-0531", "outside");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAnswer(PEPPER, "s309-b1", "kcal-0531", " OUTSIDE ")).toBe(h);
    expect(hashAnswer(PEPPER, "s309-b1", "other", "outside")).not.toBe(h);
    expect(hashAnswer("q".repeat(48), "s309-b1", "kcal-0531", "outside")).not.toBe(h);
  });
  it("refuses a short secret", () => {
    expect(() => hashAnswer("short", "b", "a", "x")).toThrow();
  });
  it("compares only well-formed digests", () => {
    const h = hashAnswer(PEPPER, "b", "a", "x");
    expect(sameHash(h, h)).toBe(true);
    expect(sameHash(h, h.replace(/.$/, h.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(sameHash(h, "not-hex")).toBe(false);
  });
});
