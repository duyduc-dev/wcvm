import { describe, expect, it } from "vitest";
import { ShellSyntaxError, tokenize } from "./tokenize";

const words = (source: string) => tokenize(source).map((t) => t.value);

describe("tokenize", () => {
  it("splits bare words on whitespace", () => {
    expect(words("echo  hello   world")).toEqual(["echo", "hello", "world"]);
  });

  it("joins single- and double-quoted parts, including adjacent to bare text", () => {
    expect(words(`echo 'a b'`)).toEqual(["echo", "a b"]);
    expect(words(`echo "a b"`)).toEqual(["echo", "a b"]);
    expect(words(`echo a'b'"c"d`)).toEqual(["echo", "abcd"]);
    expect(words(`echo ''`)).toEqual(["echo", ""]);
  });

  it("handles backslash escapes outside and inside double quotes", () => {
    expect(words(`echo a\\ b`)).toEqual(["echo", "a b"]);
    expect(words(`echo "say \\"hi\\""`)).toEqual(["echo", 'say "hi"']);
    expect(words(`echo a\\;b`)).toEqual(["echo", "a;b"]);
  });

  it("recognizes operators, including the two-char ones", () => {
    expect(tokenize("a;b").map((t) => t.value)).toEqual(["a", ";", "b"]);
    expect(tokenize("a&&b").map((t) => t.value)).toEqual(["a", "&&", "b"]);
    expect(tokenize("a||b").map((t) => t.value)).toEqual(["a", "||", "b"]);
    expect(tokenize("a|b").map((t) => t.value)).toEqual(["a", "|", "b"]);
    expect(tokenize("a>b").map((t) => t.value)).toEqual(["a", ">", "b"]);
    expect(tokenize("a>>b").map((t) => t.value)).toEqual(["a", ">>", "b"]);
    expect(tokenize("a<b").map((t) => t.value)).toEqual(["a", "<", "b"]);
  });

  it("skips # comments to end of line", () => {
    expect(words("echo hi # trailing comment\necho bye")).toEqual(["echo", "hi", "echo", "bye"]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => tokenize("echo 'unterminated")).toThrow(ShellSyntaxError);
    expect(() => tokenize('echo "unterminated')).toThrow(ShellSyntaxError);
  });

  it("rejects background jobs", () => {
    expect(() => tokenize("sleep 9 &")).toThrow(/background/);
  });
});
