import type * as Monaco from "monaco-editor";
import { rangeBefore, snippet, trailingIdentifier } from "./common";
import { DOM_EVENTS, GLOBAL_ATTRIBUTES, TAG_ATTRIBUTES } from "./htmlData";
import { scanTemplate } from "./scanner";

// An Angular template is a plain `.html` file (Monaco's own HTML service completes the HTML), but
// what makes it Angular - `[prop]`, `(event)`, `*ngIf`, `{{ expr }}` and the component's members -
// is invisible to it. This provider adds those, reading the component class (found through its
// `templateUrl`, or the same-named `.ts`) for the members a template expression can use.

type Item = Monaco.languages.CompletionItem;

const ANGULAR_TAGS = ["ng-container", "ng-template", "ng-content", "router-outlet"];
const STRUCTURAL = ["*ngIf", "*ngFor", "*ngSwitchCase", "*ngSwitchDefault"];
const PROPERTY_BINDINGS = [
  "ngClass", "ngStyle", "ngModel", "class", "style", "hidden", "disabled", "value", "src", "href", "innerHTML",
  "routerLink", "formGroup", "formControl", "checked", "readonly", "title", "id",
];
const CONTROL_FLOW: { label: string; body: string }[] = [
  { label: "@if", body: "@if (${1:condition}) {\n\t$0\n}" },
  { label: "@else", body: "@else {\n\t$0\n}" },
  { label: "@for", body: "@for (${1:item} of ${2:items}; track ${3:item.id}) {\n\t$0\n}" },
  { label: "@empty", body: "@empty {\n\t$0\n}" },
  { label: "@switch", body: "@switch (${1:value}) {\n\t@case (${2:x}) {\n\t\t$0\n\t}\n}" },
  { label: "@defer", body: "@defer {\n\t$0\n}" },
  { label: "@let", body: "@let ${1:name} = ${2:value};" },
];

interface IMember {
  name: string;
  isMethod: boolean;
}

/** Members of the component class a template can reference: public AND protected (Angular 14+ lets
 * templates read `protected` members, and the CLI's own `protected readonly title = signal(...)`
 * relies on it); `private` / `#private` are a template compile error, so they're left out. Regex
 * over the class text - good enough for the conventional `name = ...`, `name: T`, `name(...) {}`,
 * signal/`input()` fields and constructor-parameter-property shapes. */
export function componentMembers(fullSource: string): IMember[] {
  // Only the class body: the `@Component({ imports: [...], selector: ... })` decorator above it
  // has 2-space-indented `key:` lines that look just like fields.
  const classStart = /\bclass\s+[\w$]+[^{]*\{/.exec(fullSource);
  const source = classStart ? fullSource.slice(classStart.index + classStart[0].length) : fullSource;
  const members = new Map<string, IMember>();
  const decl = /^[ \t]{2}((?:(?:public|protected|private|readonly|static|override|async|get|set|declare)[ \t]+)*)([A-Za-z_$][\w$]*)[ \t]*([?!]?[ \t]*[:=;(<]|$)/gm;
  for (const m of source.matchAll(decl)) {
    const line = m[0];
    if (/\bprivate\b/.test(line) || ["constructor", "if", "for", "while", "return", "switch"].includes(m[2])) continue;
    members.set(m[2], { name: m[2], isMethod: m[3].trimStart().startsWith("(") });
  }
  for (const m of source.matchAll(/constructor\s*\(([^)]*)\)/g)) {
    for (const p of m[1].matchAll(/\b(?:public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)/g)) {
      members.set(p[1], { name: p[1], isMethod: false });
    }
  }
  return [...members.values()];
}

const joinRelative = (dir: string, rel: string): string => {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
};

/** The component class whose template is this file: the TS file whose `templateUrl` points here,
 * else the one with the same base name (`app.html` -> `app.ts`, `x.component.html` -> `x.component.ts`). */
export const componentFor = (monaco: typeof Monaco, model: Monaco.editor.ITextModel): Monaco.editor.ITextModel | null => {
  const path = model.uri.path;
  if (!path.endsWith(".html")) return null;
  for (const m of monaco.editor.getModels()) {
    if (m.uri.scheme !== "file" || !m.uri.path.endsWith(".ts") || m.uri.path.endsWith(".d.ts")) continue;
    const url = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(m.getValue())?.[1];
    if (url && joinRelative(m.uri.path.slice(0, m.uri.path.lastIndexOf("/")), url) === path) return m;
  }
  return monaco.editor.getModel(model.uri.with({ path: path.replace(/\.html$/, ".ts") }));
};

/** Every `selector: 'app-foo'` among the project's TS files - the custom tags a template can use. */
const componentSelectors = (monaco: typeof Monaco): string[] => {
  const out = new Set<string>();
  for (const m of monaco.editor.getModels()) {
    if (m.uri.scheme !== "file" || !m.uri.path.endsWith(".ts") || m.uri.path.endsWith(".d.ts")) continue;
    for (const s of m.getValue().matchAll(/selector\s*:\s*['"`]([a-z][\w-]*)['"`]/g)) out.add(s[1]);
  }
  return [...out];
};

export function registerAngularCompletions(monaco: typeof Monaco): void {
  const K = monaco.languages.CompletionItemKind;

  monaco.languages.registerCompletionItemProvider("html", {
    triggerCharacters: ["<", "[", "(", "*", "@", "{", " ", '"', "'", "."],
    provideCompletionItems(model, position) {
      const component = componentFor(monaco, model);
      if (!component) return { suggestions: [] };
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = scanTemplate(text, offset, "angular");
      const members = componentMembers(component.getValue());
      const suggestions: Item[] = [];

      const memberItems = (name: string): Item[] => {
        const range = rangeBefore(model, offset, name.length);
        return members.map((m) => ({
          label: m.name,
          kind: m.isMethod ? K.Method : K.Property,
          detail: "Component member",
          insertText: m.name,
          range,
          sortText: "0" + m.name,
        }));
      };

      switch (ctx.kind) {
        case "text": {
          // `@if`, `@for`, ... control flow blocks (Angular 17+).
          const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const at = /@\w*$/.exec(linePrefix);
          if (at) {
            const range = rangeBefore(model, offset, at[0].length);
            for (const b of CONTROL_FLOW) suggestions.push(snippet(monaco, b.label, b.body, range, K.Snippet, "Angular control flow", "0" + b.label));
          }
          break;
        }
        case "tag-name": {
          const range = rangeBefore(model, offset, ctx.prefix.length);
          for (const t of [...ANGULAR_TAGS, ...componentSelectors(monaco)]) {
            suggestions.push({ label: t, kind: K.Class, detail: "Angular", insertText: t, range, sortText: "0" + t });
          }
          break;
        }
        case "attr-name": {
          const range = rangeBefore(model, offset, ctx.prefix.length);
          const add = (label: string, body: string, kind: Monaco.languages.CompletionItemKind, detail: string): void => {
            suggestions.push(snippet(monaco, label, body, range, kind, detail, "0" + label));
          };
          for (const s of STRUCTURAL) add(s, `${s}="$1"`, K.Keyword, "Structural directive");
          for (const p of PROPERTY_BINDINGS) add(`[${p}]`, `[${p}]="$1"`, K.Property, "Property binding");
          add("[(ngModel)]", '[(ngModel)]="$1"', K.Property, "Two-way binding");
          add("[class.]", '[class.$1]="$2"', K.Property, "Class binding");
          add("[style.]", '[style.$1]="$2"', K.Property, "Style binding");
          add("[attr.]", '[attr.$1]="$2"', K.Property, "Attribute binding");
          for (const e of DOM_EVENTS) add(`(${e})`, `(${e})="$1"`, K.Event, "Event binding");
          add("(keyup.enter)", '(keyup.enter)="$1"', K.Event, "Event binding");
          add("#ref", "#${1:ref}", K.Variable, "Template reference variable");
          for (const a of [...GLOBAL_ATTRIBUTES, ...(TAG_ATTRIBUTES[ctx.tag.toLowerCase()] ?? [])]) {
            suggestions.push(snippet(monaco, a, `${a}="$1"`, range, K.Property, undefined, "1" + a));
          }
          break;
        }
        case "attr-value": {
          if (!/^(\[|\(|\*)/.test(ctx.attr)) break;
          const { name, isMember } = trailingIdentifier(ctx.prefix);
          if (!isMember) suggestions.push(...memberItems(name));
          break;
        }
        case "expression": {
          const { name, isMember } = trailingIdentifier(ctx.prefix);
          if (!isMember) suggestions.push(...memberItems(name));
          break;
        }
        default:
          break;
      }
      return { suggestions };
    },
  });
}
