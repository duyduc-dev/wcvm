import { describe, expect, it } from "vitest";
import { parse } from "./parse";
import { ShellSyntaxError } from "./tokenize";

describe("parse", () => {
  it("parses a single simple command", () => {
    expect(parse("echo hi")).toEqual({
      parts: [{ pipeline: { commands: [{ words: ["echo", "hi"], redirects: [] }] } }],
    });
  });

  it("parses a pipeline", () => {
    const script = parse("cat a.txt | node -e 1");
    expect(script.parts).toHaveLength(1);
    expect(script.parts[0].pipeline.commands).toEqual([
      { words: ["cat", "a.txt"], redirects: [] },
      { words: ["node", "-e", "1"], redirects: [] },
    ]);
  });

  it("parses ; && || as separators between pipelines, with the right op", () => {
    const script = parse("a; b && c || d");
    expect(script.parts.map((p) => p.op)).toEqual([undefined, ";", "&&", "||"]);
    expect(script.parts.map((p) => p.pipeline.commands[0].words[0])).toEqual(["a", "b", "c", "d"]);
  });

  it("allows a trailing ; with nothing after it", () => {
    expect(parse("echo hi;").parts).toHaveLength(1);
  });

  it("parses redirects attached to a command, in any position", () => {
    expect(parse("cat < in.txt > out.txt").parts[0].pipeline.commands[0]).toEqual({
      words: ["cat"],
      redirects: [
        { type: "<", target: "in.txt" },
        { type: ">", target: "out.txt" },
      ],
    });
    expect(parse("> out.txt echo hi").parts[0].pipeline.commands[0]).toEqual({
      words: ["echo", "hi"],
      redirects: [{ type: ">", target: "out.txt" }],
    });
  });

  it("rejects an empty command", () => {
    expect(() => parse("")).toThrow(ShellSyntaxError);
    expect(() => parse(";")).toThrow(ShellSyntaxError);
    expect(() => parse("echo a |")).toThrow(ShellSyntaxError);
    expect(() => parse("echo a &&")).toThrow(/expected a command/);
  });

  it("rejects a redirect with no filename", () => {
    expect(() => parse("echo hi >")).toThrow(/filename/);
  });

  it("rejects a stray trailing token", () => {
    expect(() => parse("echo hi | | cat")).toThrow(ShellSyntaxError);
  });
});
