/** Static HTML vocabulary for the template completion providers (Monaco's own HTML language
 * service only runs for the `html` language id, not for `.vue` / `.svelte`). */

export const HTML_TAGS = [
  "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote", "body", "br", "button", "canvas", "caption",
  "code", "col", "colgroup", "data", "datalist", "dd", "details", "dialog", "div", "dl", "dt", "em", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "i",
  "iframe", "img", "input", "label", "legend", "li", "link", "main", "mark", "menu", "meta", "meter", "nav", "noscript",
  "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "section", "select", "slot", "small",
  "source", "span", "strong", "style", "sub", "summary", "sup", "svg", "table", "tbody", "td", "template", "textarea",
  "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "video",
];

export const GLOBAL_ATTRIBUTES = [
  "class", "id", "style", "title", "hidden", "tabindex", "lang", "dir", "draggable", "contenteditable", "role",
  "aria-label", "aria-hidden", "aria-describedby", "data-", "slot", "ref",
];

export const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel", "download"],
  img: ["src", "alt", "width", "height", "loading"],
  input: ["type", "value", "name", "placeholder", "disabled", "required", "checked", "min", "max", "step", "readonly", "autofocus"],
  textarea: ["value", "name", "placeholder", "rows", "cols", "disabled", "required", "readonly"],
  select: ["name", "multiple", "disabled", "required"],
  option: ["value", "selected", "disabled"],
  button: ["type", "disabled", "name", "value"],
  form: ["action", "method", "enctype", "novalidate"],
  label: ["for"],
  link: ["rel", "href", "type"],
  meta: ["name", "content", "charset"],
  script: ["src", "type", "async", "defer"],
  video: ["src", "controls", "autoplay", "loop", "muted", "poster"],
  audio: ["src", "controls", "autoplay", "loop", "muted"],
  iframe: ["src", "width", "height", "allow", "sandbox"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
};

/** DOM event names (without any framework prefix). */
export const DOM_EVENTS = [
  "click", "dblclick", "input", "change", "submit", "keydown", "keyup", "keypress", "focus", "blur", "mouseenter",
  "mouseleave", "mousedown", "mouseup", "mousemove", "scroll", "wheel", "resize", "load", "error", "drag", "drop",
  "dragover", "touchstart", "touchend", "contextmenu", "pointerdown", "pointerup",
];
