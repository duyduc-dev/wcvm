import type * as Monaco from "monaco-editor";
import { registerAngularCompletions } from "./angular";
import { registerTemplateDefinitions } from "./definitions";
import { registerTemplateDiagnostics } from "./diagnostics";
import { registerTemplateHover } from "./hover";
import { registerVueSvelteCompletions } from "./vueSvelte";

/** Completion for the template formats Monaco has no language service for: Vue and Svelte single-
 * file components (script blocks via the TS worker, plus tags / attributes / expressions) and
 * Angular's HTML templates (bindings and the component's members). Also flags Vue/Svelte components
 * used without being imported, and shows TypeScript's type on hover. */
export function registerTemplateCompletions(monaco: typeof Monaco): void {
  registerVueSvelteCompletions(monaco);
  registerAngularCompletions(monaco);
  registerTemplateDiagnostics(monaco);
  registerTemplateDefinitions(monaco);
  registerTemplateHover(monaco);
}
