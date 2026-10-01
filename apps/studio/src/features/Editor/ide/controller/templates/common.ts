import type * as Monaco from "monaco-editor";

export const rangeBefore = (model: Monaco.editor.ITextModel, offset: number, length: number): Monaco.IRange => {
  const start = model.getPositionAt(offset - length);
  const end = model.getPositionAt(offset);
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
};

/** The identifier being typed at the end of `text` and whether it is a member access (`foo.|`),
 * which a template completion can't answer (it has no types for the expression on the left). */
export const trailingIdentifier = (text: string): { name: string; isMember: boolean } => {
  const m = /([A-Za-z_$][\w$]*)?$/.exec(text);
  const name = m?.[1] ?? "";
  const before = text.slice(0, text.length - name.length).trimEnd();
  return { name, isMember: before.endsWith(".") || before.endsWith("?.") };
};

export const snippet = (
  monaco: typeof Monaco,
  label: string,
  insertText: string,
  range: Monaco.IRange,
  kind: Monaco.languages.CompletionItemKind,
  detail?: string,
  sortText?: string,
): Monaco.languages.CompletionItem => ({
  label,
  kind,
  detail,
  insertText,
  insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
  range,
  sortText,
});
