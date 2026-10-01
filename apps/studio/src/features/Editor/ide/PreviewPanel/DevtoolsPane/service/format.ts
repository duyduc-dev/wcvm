/** Turns values from the previewed page into display strings. The page lives in another realm
 * (its own iframe), so `instanceof` can't be trusted - everything is duck-typed or goes through
 * `Object.prototype.toString`. Nothing here holds on to the value: console entries are kept as
 * text so a page's objects aren't pinned in memory by the log. */

const MAX_DEPTH = 3;
const MAX_ITEMS = 50;

const tagOf = (v: unknown): string => Object.prototype.toString.call(v).slice(8, -1);

export const describeElement = (el: Element): string => {
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).join(".")
      : "";
  return `<${el.localName}${id}${cls}>`;
};

export function formatValue(v: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  try {
    switch (typeof v) {
      case "string":
        return depth === 0 ? v : JSON.stringify(v);
      case "function": {
        const name = (v as { name?: string }).name;
        return `ƒ ${name || "(anonymous)"}()`;
      }
      case "symbol":
      case "bigint":
        return String(v) + (typeof v === "bigint" ? "n" : "");
      case "object":
        break;
      default:
        return String(v);
    }
    if (v === null) return "null";
    const obj = v as Record<string, unknown>;
    const tag = tagOf(obj);
    if (tag.endsWith("Error") || (typeof obj.stack === "string" && typeof obj.message === "string")) {
      return String(obj.stack || `${String(obj.name)}: ${String(obj.message)}`);
    }
    if (typeof obj.nodeType === "number") {
      return obj.nodeType === 1 ? describeElement(obj as unknown as Element) : `#${String(obj.nodeName)}`;
    }
    if (tag === "Window") return "Window";
    if (seen.has(v)) return "[Circular]";
    if (depth >= MAX_DEPTH) return tag === "Array" ? `Array(${(obj as unknown as unknown[]).length})` : "{…}";
    seen.add(v);
    let out: string;
    if (tag === "Array") {
      const arr = obj as unknown as unknown[];
      const items = arr.slice(0, MAX_ITEMS).map((x) => formatValue(x, depth + 1, seen));
      if (arr.length > MAX_ITEMS) items.push(`… ${arr.length - MAX_ITEMS} more`);
      out = `[${items.join(", ")}]`;
    } else if (tag === "Map") {
      const parts = [...(obj as unknown as Map<unknown, unknown>)]
        .slice(0, MAX_ITEMS)
        .map(([k, x]) => `${formatValue(k, depth + 1, seen)} => ${formatValue(x, depth + 1, seen)}`);
      out = `Map(${(obj as unknown as Map<unknown, unknown>).size}) {${parts.join(", ")}}`;
    } else if (tag === "Set") {
      const parts = [...(obj as unknown as Set<unknown>)].slice(0, MAX_ITEMS).map((x) => formatValue(x, depth + 1, seen));
      out = `Set(${(obj as unknown as Set<unknown>).size}) {${parts.join(", ")}}`;
    } else if (tag === "Date") {
      out = String((obj as unknown as Date).toISOString?.() ?? obj);
    } else if (tag === "RegExp") {
      out = String(obj);
    } else {
      const keys = Object.keys(obj);
      const parts = keys.slice(0, MAX_ITEMS).map((k) => `${k}: ${formatValue(obj[k], depth + 1, seen)}`);
      if (keys.length > MAX_ITEMS) parts.push(`… ${keys.length - MAX_ITEMS} more`);
      const ctor = (Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null)?.constructor?.name;
      out = `${ctor && ctor !== "Object" ? ctor + " " : ""}{${parts.join(", ")}}`;
    }
    seen.delete(v);
    return out;
  } catch {
    return "[object]";
  }
}

/** `console.log("a %s b %d", x, y)` style substitution; the rest of the args are appended. */
export function formatArgs(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== "string" || !first.includes("%")) return args.map((a) => formatValue(a)).join(" ");
  const text = first.replace(/%([sdifoOjc%])/g, (match, spec: string) => {
    if (spec === "%") return "%";
    if (rest.length === 0) return match;
    const arg = rest.shift();
    switch (spec) {
      case "c":
        return "";
      case "s":
        return typeof arg === "string" ? arg : formatValue(arg, 1);
      case "d":
      case "i": {
        const n = spec === "i" ? parseInt(String(arg), 10) : Number(arg);
        return String(n);
      }
      case "f":
        return String(parseFloat(String(arg)));
      default:
        return formatValue(arg, 1);
    }
  });
  return [text, ...rest.map((a) => formatValue(a))].join(" ");
}
