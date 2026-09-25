import { describe, expect, it } from "vitest";
import { mangleCreateName } from "./exec";

describe("mangleCreateName", () => {
  // Checked against real npm 11's own `lib/commands/init.js#execCreate`.
  it.each([
    ["vite", "create-vite"],
    ["react-router", "create-react-router"],
    // Real npm doesn't special-case an already-"create-"-prefixed name either.
    ["create-vite", "create-create-vite"],
    ["@foo/bar", "@foo/create-bar"],
    ["@foo/create-bar", "@foo/create-create-bar"],
    // A bare scope (no name after it) becomes "<scope>/create", not "<scope>/create-".
    ["@foo", "@foo/create"],
  ])("mangles %s to %s", (input, expected) => {
    expect(mangleCreateName(input)).toBe(expected);
  });
});
