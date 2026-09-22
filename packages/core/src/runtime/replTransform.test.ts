import { describe, expect, it } from "vitest";
import { createTestLoader } from "./testing";
import { liftTopLevelDeclarations } from "./replTransform";

const acorn = createTestLoader().require("internal/deps/acorn/acorn/dist/acorn");

describe("liftTopLevelDeclarations", () => {
  it("rewrites a top-level let to var", () => {
    expect(liftTopLevelDeclarations(acorn, "let x = 5")).toBe("var x = 5");
  });

  it("rewrites a top-level const to var", () => {
    expect(liftTopLevelDeclarations(acorn, "const x = 5")).toBe("var x = 5");
  });

  it("rewrites multiple top-level declarations on one line", () => {
    expect(liftTopLevelDeclarations(acorn, "let a = 1; const b = 2;")).toBe("var a = 1; var b = 2;");
  });

  it("preserves a multi-declarator statement", () => {
    expect(liftTopLevelDeclarations(acorn, "let x = 5, y = 10;")).toBe("var x = 5, y = 10;");
  });

  it("preserves destructuring", () => {
    expect(liftTopLevelDeclarations(acorn, "let { a, b } = obj;")).toBe("var { a, b } = obj;");
  });

  it("leaves a let nested inside a for-loop header alone", () => {
    const source = "for (let i = 0; i < 3; i++) sum += i;";
    expect(liftTopLevelDeclarations(acorn, source)).toBe(source);
  });

  it("leaves a let nested inside a block alone", () => {
    const source = "{ let x = 1; console.log(x); }";
    expect(liftTopLevelDeclarations(acorn, source)).toBe(source);
  });

  it("leaves plain expressions and var declarations alone", () => {
    expect(liftTopLevelDeclarations(acorn, "1 + 1")).toBe("1 + 1");
    expect(liftTopLevelDeclarations(acorn, "var x = 1")).toBe("var x = 1");
  });

  it("returns the source unchanged if it doesn't parse, so the real eval reports the SyntaxError", () => {
    expect(liftTopLevelDeclarations(acorn, "let x =")).toBe("let x =");
  });
});
