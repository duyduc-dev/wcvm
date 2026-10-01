import type * as Monaco from "monaco-editor";
import { snippet, rangeBefore, trailingIdentifier } from "./common";
import { DOM_EVENTS, GLOBAL_ATTRIBUTES, HTML_TAGS, TAG_ATTRIBUTES } from "./htmlData";
import { scanTemplate, type Flavor } from "./scanner";
import { componentImportEdit, importableComponents, importedComponentNames } from "./componentImport";
import { scriptBlocks, scriptCompletions } from "./shadowScript";

type Item = Monaco.languages.CompletionItem;

const VUE_TAGS = ["component", "transition", "transition-group", "keep-alive", "teleport", "suspense", "router-link", "router-view"];
const SVELTE_TAGS = [
  "svelte:head", "svelte:window", "svelte:body", "svelte:document", "svelte:self", "svelte:component",
  "svelte:fragment", "svelte:element", "svelte:options", "svelte:boundary",
];
const VUE_DIRECTIVES = ["v-if", "v-else-if", "v-else", "v-for", "v-show", "v-model", "v-bind", "v-on", "v-html", "v-text", "v-slot", "v-once", "v-pre", "v-cloak"];
const VUE_MACROS = ["defineProps", "defineEmits", "defineExpose", "defineModel", "defineOptions", "defineSlots", "withDefaults"];
const SVELTE_RUNES = ["$state", "$derived", "$effect", "$props", "$bindable", "$inspect", "$host"];
const SVELTE_BLOCKS: { label: string; body: string }[] = [
  { label: "#if", body: "#if ${1:condition}}\n\t$0\n{/if}" },
  { label: "#each", body: "#each ${1:items} as ${2:item}}\n\t$0\n{/each}" },
  { label: "#await", body: "#await ${1:promise}}\n\t$0\n{/await}" },
  { label: "#key", body: "#key ${1:value}}\n\t$0\n{/key}" },
  { label: "#snippet", body: "#snippet ${1:name}()}\n\t$0\n{/snippet}" },
  { label: ":else", body: ":else}" },
  { label: ":else if", body: ":else if ${1:condition}}" },
  { label: ":then", body: ":then ${1:value}}" },
  { label: ":catch", body: ":catch ${1:error}}" },
  { label: "@html", body: "@html ${1:html}}" },
  { label: "@const", body: "@const ${1:name} = ${2:value}}" },
  { label: "@debug", body: "@debug ${1:variable}}" },
  { label: "@render", body: "@render ${1:snippet}()}" },
];

function tagItems(monaco: typeof Monaco, model: Monaco.editor.ITextModel, flavor: "vue" | "svelte", range: Monaco.IRange): Item[] {
  const text = model.getValue();
  const K = monaco.languages.CompletionItemKind;
  const builtins = flavor === "vue" ? VUE_TAGS : SVELTE_TAGS;
  return [
    ...HTML_TAGS.map((t) => ({ label: t, kind: K.Property, insertText: t, range, sortText: "1" + t })),
    ...builtins.map((t) => ({ label: t, kind: K.Keyword, insertText: t, range, sortText: "2" + t })),
    ...[...importedComponentNames(text)].map((t) => ({ label: t, kind: K.Class, detail: "Imported component", insertText: t, range, sortText: "0" + t })),
    // Components in the project that aren't imported yet: accepting one adds the import.
    ...importableComponents(model.uri.path, text).map((c) => ({
      label: { label: c.name, description: c.spec },
      kind: K.Class,
      detail: `Auto import from "${c.spec}"`,
      insertText: c.name,
      range,
      sortText: "0" + c.name,
      additionalTextEdits: [componentImportEdit(model, flavor, c)],
    })),
  ];
}

function attributeItems(monaco: typeof Monaco, flavor: Flavor, tag: string, range: Monaco.IRange): Item[] {
  const K = monaco.languages.CompletionItemKind;
  const items: Item[] = [];
  const attr = (name: string): void => {
    items.push(snippet(monaco, name, `${name}="$1"`, range, K.Property, undefined, "1" + name));
  };
  for (const name of [...GLOBAL_ATTRIBUTES, ...(TAG_ATTRIBUTES[tag.toLowerCase()] ?? [])]) attr(name);

  if (flavor === "vue") {
    for (const d of VUE_DIRECTIVES) {
      items.push(snippet(monaco, d, d === "v-else" || d === "v-once" || d === "v-pre" || d === "v-cloak" ? d : `${d}="$1"`, range, K.Keyword, "Vue directive", "0" + d));
    }
    for (const e of DOM_EVENTS) items.push(snippet(monaco, `@${e}`, `@${e}="$1"`, range, K.Event, "Vue event", "0@" + e));
    for (const name of ["class", "style", "key", "id", "src", "href", "value", "disabled", "ref"]) {
      items.push(snippet(monaco, `:${name}`, `:${name}="$1"`, range, K.Property, "Vue binding", "0:" + name));
    }
    items.push(snippet(monaco, "v-model.trim", 'v-model.trim="$1"', range, K.Keyword), snippet(monaco, "@submit.prevent", '@submit.prevent="$1"', range, K.Event));
  } else {
    for (const e of DOM_EVENTS) items.push(snippet(monaco, `on:${e}`, `on:${e}={$1}`, range, K.Event, "Svelte event", "0on:" + e));
    for (const [name, body] of [
      ["bind:value", "bind:value={$1}"], ["bind:checked", "bind:checked={$1}"], ["bind:this", "bind:this={$1}"],
      ["bind:group", "bind:group={$1}"], ["class:", "class:${1:name}={$2}"], ["use:", "use:${1:action}"],
      ["transition:", "transition:${1:fade}"], ["in:", "in:${1:fade}"], ["out:", "out:${1:fade}"],
      ["animate:", "animate:${1:flip}"], ["let:", "let:${1:item}"], ["style:", "style:${1:property}={$2}"],
    ]) {
      items.push(snippet(monaco, name, body, range, K.Keyword, "Svelte directive", "0" + name));
    }
    for (const e of DOM_EVENTS) items.push(snippet(monaco, `on${e}`, `on${e}={$1}`, range, K.Event, "Svelte 5 event", "1on" + e));
  }
  return items;
}

export function registerVueSvelteCompletions(monaco: typeof Monaco): void {
  const K = monaco.languages.CompletionItemKind;

  for (const flavor of ["vue", "svelte"] as const) {
    monaco.languages.registerCompletionItemProvider(flavor, {
      triggerCharacters: ["<", "/", ":", "@", "{", "#", ".", " ", '"', "'", "-", "$"],
      async provideCompletionItems(model, position) {
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const ctx = scanTemplate(text, offset, flavor);

        switch (ctx.kind) {
          case "style":
          case "text":
            return { suggestions: [] };

          case "script": {
            const word = model.getWordUntilPosition(position);
            const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
            const suggestions = await scriptCompletions(monaco, model, offset, range);
            const extras = flavor === "vue" ? VUE_MACROS : SVELTE_RUNES;
            const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
            if (!/\.\s*\w*$/.test(lineBefore)) {
              for (const name of extras) suggestions.push({ label: name, kind: K.Function, insertText: name, range: { ...range, startColumn: flavor === "svelte" && lineBefore.endsWith("$") ? word.startColumn - 1 : word.startColumn }, sortText: "0" + name });
            }
            return { suggestions };
          }

          case "tag-name":
            return { suggestions: tagItems(monaco, model, flavor, rangeBefore(model, offset, ctx.prefix.length)) };

          case "close-tag": {
            if (!ctx.open) return { suggestions: [] };
            const range = rangeBefore(model, offset, ctx.prefix.length);
            return { suggestions: [{ label: ctx.open, kind: K.Property, insertText: `${ctx.open}>`, range, sortText: "0" }] };
          }

          case "attr-name":
            return { suggestions: attributeItems(monaco, flavor, ctx.tag, rangeBefore(model, offset, ctx.prefix.length)) };

          case "attr-value":
          case "expression": {
            const isExpression =
              ctx.kind === "expression" ||
              (flavor === "vue" && /^(:|@|v-(?!else$))/.test(ctx.attr) && !/^v-slot|^#/.test(ctx.attr)) ||
              (flavor === "svelte" && /^(on:|bind:|class:|use:|style:)/.test(ctx.attr));
            if (!isExpression) return { suggestions: [] };

            // Svelte `{#if ...}` / `{:else}` / `{@html ...}` blocks: offered right after a bare `{`
            // (alongside the bindings) and exclusively once a `#`, `:`, `/` or `@` has been typed.
            let blocks: Item[] = [];
            if (flavor === "svelte" && ctx.kind === "expression" && (ctx.prefix === "" || /^[#:/@][\w ]*$/.test(ctx.prefix))) {
              const range = rangeBefore(model, offset, ctx.prefix.length);
              // The block bodies end in their own `}`, so swallow one that is already there.
              const end = model.getPositionAt(text[offset] === "}" ? offset + 1 : offset);
              const full = { ...range, endLineNumber: end.lineNumber, endColumn: end.column };
              blocks = SVELTE_BLOCKS.map((b) => snippet(monaco, b.label, b.body, full, K.Snippet, "Svelte block", "0" + b.label));
              if (ctx.prefix !== "") return { suggestions: blocks };
            }

            const { name, isMember } = trailingIdentifier(ctx.prefix);
            if (isMember) return { suggestions: [] };
            const last = scriptBlocks(text).at(-1);
            if (!last) return { suggestions: blocks };
            const suggestions = await scriptCompletions(monaco, model, last.end, rangeBefore(model, offset, name.length), { onlyLocals: true });
            return { suggestions: [...blocks, ...suggestions] };
          }
        }
      },
    });
  }
}
