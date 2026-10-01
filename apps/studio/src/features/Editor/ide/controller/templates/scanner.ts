/** What the cursor is inside, in a Vue / Svelte / Angular template. Monaco has no language
 * service for these formats, so the completion providers in this folder work from this: a small
 * forward scan of the markup up to the cursor (tags, attributes, quotes, `{{ }}` / `{ }`
 * expressions, comments, raw `<script>`/`<style>` bodies). It is deliberately not a full HTML
 * parser - it only has to answer "where am I" for text that is being typed and so is often
 * incomplete. */

export type Flavor = "vue" | "svelte" | "angular";

export type TemplateContext =
  | { kind: "script" }
  | { kind: "style" }
  | { kind: "text" }
  | { kind: "tag-name"; prefix: string }
  | { kind: "close-tag"; open: string | null; prefix: string }
  | { kind: "attr-name"; tag: string; prefix: string }
  | { kind: "attr-value"; tag: string; attr: string; prefix: string }
  | { kind: "expression"; prefix: string };

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style"]);
const TAG_NAME_CHAR = /[\w:.-]/;
const isSpace = (ch: string): boolean => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

type Mode = "text" | "opentag" | "closetag" | "comment" | "raw" | "mustache" | "brace";
type Sub = "name" | "between" | "attrname" | "afterattr" | "valstart" | "valq" | "valuq" | "brace";

export function scanTemplate(text: string, offset: number, flavor: Flavor): TemplateContext {
  // Assigned inside `finishTag` too, which control-flow narrowing can't see - hence the cast.
  let mode = "text" as Mode;
  let sub: Sub = "name";
  const stack: string[] = [];
  let tagName = "";
  let attrName = "";
  let quote = "";
  let valueStart = 0;
  let nameStart = 0;
  let exprStart = 0;
  let depth = 0;
  let lastNonSpace = "";
  let i = 0;

  const finishTag = (): void => {
    const lower = tagName.toLowerCase();
    if (RAW_TAGS.has(lower) && lastNonSpace !== "/") {
      mode = "raw";
      return;
    }
    if (!VOID_TAGS.has(lower) && lastNonSpace !== "/") stack.push(tagName);
    mode = "text";
  };

  while (i < offset) {
    const ch = text[i];
    switch (mode) {
      case "text": {
        if (text.startsWith("<!--", i)) {
          mode = "comment";
          i += 4;
          continue;
        }
        if (ch === "<") {
          if (text[i + 1] === "/" && i + 1 < offset) {
            mode = "closetag";
            nameStart = i + 2;
            i += 2;
            continue;
          }
          if (i + 1 >= offset || /[A-Za-z]/.test(text[i + 1])) {
            mode = "opentag";
            sub = "name";
            tagName = "";
            lastNonSpace = "";
            nameStart = i + 1;
          }
        } else if (flavor !== "svelte" && ch === "{" && text[i + 1] === "{" && i + 1 < offset) {
          mode = "mustache";
          exprStart = i + 2;
          i += 2;
          continue;
        } else if (flavor === "svelte" && ch === "{") {
          mode = "brace";
          depth = 1;
          exprStart = i + 1;
        }
        break;
      }
      case "comment": {
        const end = text.indexOf("-->", i);
        if (end === -1 || end + 3 > offset) return { kind: "text" };
        i = end + 3;
        mode = "text";
        continue;
      }
      case "raw": {
        const close = text.toLowerCase().indexOf(`</${tagName.toLowerCase()}`, i);
        if (close === -1 || close >= offset) return { kind: tagName.toLowerCase() === "style" ? "style" : "script" };
        mode = "closetag";
        nameStart = close + 2;
        i = close + 2;
        continue;
      }
      case "mustache": {
        if (ch === "}" && text[i + 1] === "}") {
          mode = "text";
          i += 2;
          continue;
        }
        break;
      }
      case "brace": {
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) mode = "text";
        break;
      }
      case "closetag": {
        if (ch === ">") {
          const name = text.slice(nameStart, i).trim();
          const at = stack.lastIndexOf(name);
          if (at !== -1) stack.length = at;
          mode = "text";
        }
        break;
      }
      case "opentag": {
        if (!isSpace(ch)) lastNonSpace = ch;
        switch (sub) {
          case "name":
            if (TAG_NAME_CHAR.test(ch)) tagName += ch;
            else {
              sub = "between";
              continue; // reprocess this character
            }
            break;
          case "between":
            if (ch === ">") finishTag();
            else if (ch === "/" || isSpace(ch)) break;
            else if (flavor === "svelte" && ch === "{") {
              sub = "brace";
              depth = 1;
              exprStart = i + 1;
            } else {
              sub = "attrname";
              attrName = ch;
            }
            break;
          case "attrname":
            if (ch === "=") sub = "valstart";
            else if (ch === ">") finishTag();
            else if (isSpace(ch)) sub = "afterattr";
            else attrName += ch;
            break;
          case "afterattr":
            if (ch === "=") sub = "valstart";
            else if (ch === ">") finishTag();
            else if (!isSpace(ch)) {
              sub = "attrname";
              attrName = ch;
            }
            break;
          case "valstart":
            if (ch === '"' || ch === "'") {
              sub = "valq";
              quote = ch;
              valueStart = i + 1;
            } else if (isSpace(ch)) break;
            else if (flavor === "svelte" && ch === "{") {
              sub = "brace";
              depth = 1;
              exprStart = i + 1;
            } else {
              sub = "valuq";
              valueStart = i;
            }
            break;
          case "valq":
            if (ch === quote) sub = "between";
            break;
          case "valuq":
            if (ch === ">") finishTag();
            else if (isSpace(ch)) sub = "between";
            break;
          case "brace":
            if (ch === "{") depth++;
            else if (ch === "}" && --depth === 0) sub = "between";
            break;
        }
        break;
      }
    }
    i++;
  }

  switch (mode) {
    case "text":
      return { kind: "text" };
    case "comment":
      return { kind: "text" };
    case "raw":
      return { kind: tagName.toLowerCase() === "style" ? "style" : "script" };
    case "mustache":
    case "brace":
      return { kind: "expression", prefix: text.slice(exprStart, offset) };
    case "closetag":
      return { kind: "close-tag", open: stack.at(-1) ?? null, prefix: text.slice(nameStart, offset) };
    case "opentag":
      switch (sub) {
        case "name":
          return { kind: "tag-name", prefix: text.slice(nameStart, offset) };
        case "between":
        case "afterattr":
          return { kind: "attr-name", tag: tagName, prefix: "" };
        case "attrname":
          return { kind: "attr-name", tag: tagName, prefix: attrName };
        case "valstart":
          return { kind: "attr-value", tag: tagName, attr: attrName, prefix: "" };
        case "valq":
        case "valuq":
          return { kind: "attr-value", tag: tagName, attr: attrName, prefix: text.slice(valueStart, offset) };
        case "brace":
          return { kind: "expression", prefix: text.slice(exprStart, offset) };
      }
  }
  return { kind: "text" };
}
