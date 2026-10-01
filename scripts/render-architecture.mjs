#!/usr/bin/env node
// Keeps the README's "Architecture" section in step with ARCHITECTURE.md (the source of truth).
//
//   node scripts/render-architecture.mjs
//
// 1. Renders every ```mermaid block of ARCHITECTURE.md to assets/architecture/NN-name.svg. SVG images (not
//    inline Mermaid) because npm does not render Mermaid, and GitHub's dark mode would clash with a transparent
//    diagram: each SVG carries its own white background. Text is plain SVG <text>, not <foreignObject>, so the
//    files render the same wherever they are shown as an image.
// 2. Writes the docs site's architecture page (apps/docs/architecture.md) and copies the SVGs next to it.
// 3. Rewrites the block between the architecture markers in README.md and packages/core/README.md, with the
//    diagrams replaced by those images (relative paths in the root README, raw GitHub URLs in the package README,
//    which npm shows without the repository around it).
//
// Needs network access (it loads Mermaid from a CDN) and Playwright's Chromium, which examples/playground installs.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(path.join(root, "examples/playground/package.json"))("@playwright/test");

const RAW = "https://raw.githubusercontent.com/duyduc-dev/wcvm/main/";
const BLOB = "https://github.com/duyduc-dev/wcvm/blob/main/";
const START = "<!-- architecture:start (generated from ARCHITECTURE.md by scripts/render-architecture.mjs; edit ARCHITECTURE.md) -->";
const END = "<!-- architecture:end -->";

// One entry per Mermaid block, in document order.
const DIAGRAMS = [
  ["system-overview", "System overview: host page, kernel, file system, process, fetcher and preview workers"],
  ["boot", "Boot sequence between the host page, the kernel worker, the file system worker and OPFS"],
  ["syscall-bridge", "A synchronous syscall: the guest writes a request into a SharedArrayBuffer and waits; the servicer answers and wakes it"],
  ["processes", "How wc.spawn resolves a program: builtins, sh, npm and node"],
  ["runtime", "The Node runtime: Node's vendored lib/ on top of wcvm's bindings, shims, event loop and loaders"],
  ["preview-relay", "A preview request from the iframe through the Service Worker and host page to a guest server"],
  ["filesystem", "The file system worker, the Vfs, and the ordered write-behind mirror to OPFS"],
  ["studio", "Studio's layering on top of the wcvm API"],
];

const architecture = fs.readFileSync(path.join(root, "ARCHITECTURE.md"), "utf8");
const blocks = [...architecture.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length !== DIAGRAMS.length) throw new Error(`ARCHITECTURE.md has ${blocks.length} diagrams, this script names ${DIAGRAMS.length}: update DIAGRAMS`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" });
const rendered = await page.evaluate(async (blocks) => {
  mermaid.initialize({
    startOnLoad: false,
    htmlLabels: false,
    theme: "base",
    themeVariables: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSize: "15px",
      primaryColor: "#EDE9FF",
      primaryBorderColor: "#5236E0",
      primaryTextColor: "#1C1B2E",
      lineColor: "#5236E0",
      secondaryColor: "#F6F4FF",
      tertiaryColor: "#FFFFFF",
      clusterBkg: "#FAF9FF",
      clusterBorder: "#C9C4F5",
      edgeLabelBackground: "#FFFFFF",
      actorBkg: "#EDE9FF",
      actorBorder: "#5236E0",
      actorTextColor: "#1C1B2E",
      signalColor: "#5236E0",
      signalTextColor: "#1C1B2E",
      noteBkgColor: "#FFF8DC",
      noteBorderColor: "#D8C77A",
      noteTextColor: "#1C1B2E",
      activationBkgColor: "#EDE9FF",
      sequenceNumberColor: "#FFFFFF",
    },
    flowchart: { htmlLabels: false, curve: "basis", padding: 14 },
    sequence: { useMaxWidth: false, mirrorActors: false },
  });
  const out = [];
  for (const [i, src] of blocks.entries()) {
    const { svg } = await mermaid.render(`d${i}`, src);
    // A standalone SVG has to be well-formed XML: an HTML label (<foreignObject> with a bare <br>) is not, and
    // the image then shows as broken.
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const error = doc.querySelector("parsererror");
    if (error || svg.includes("foreignObject")) throw new Error(`diagram ${i + 1} is not a plain, well-formed SVG: ${error?.textContent?.slice(0, 200) ?? "uses foreignObject"}`);
    out.push(svg);
  }
  return out;
}, blocks);
await browser.close();

fs.mkdirSync(path.join(root, "assets/architecture"), { recursive: true });
const files = rendered.map((svg, i) => {
  const viewBox = /viewBox="([\d.\-\s]+)"/.exec(svg)?.[1].split(/\s+/).map(Number);
  if (!viewBox) throw new Error(`diagram ${i + 1} has no viewBox`);
  const [, , w, h] = viewBox;
  const sized = svg
    .replace(/<svg([^>]*?)\swidth="[^"]*"/, "<svg$1")
    .replace(/<svg([^>]*?)\sheight="[^"]*"/, "<svg$1")
    .replace(/(<svg[^>]*?)\sstyle="[^"]*"/, "$1")
    .replace(/<svg/, `<svg width="${Math.ceil(w)}" height="${Math.ceil(h)}"`)
    .replace(/(<svg[^>]*>)/, `$1<rect x="${viewBox[0]}" y="${viewBox[1]}" width="${w}" height="${h}" fill="#FFFFFF"/>`);
  const file = `assets/architecture/${String(i + 1).padStart(2, "0")}-${DIAGRAMS[i][0]}.svg`;
  fs.writeFileSync(path.join(root, file), sized);
  return file;
});

// The docs site page: the same body, images served from /architecture/ by the docs site.
const docsImages = path.join(root, "apps/docs/public/architecture");
fs.rmSync(docsImages, { recursive: true, force: true });
fs.mkdirSync(docsImages, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(docsImages, path.basename(file)));
const docsBody = (() => {
  let n = 0;
  return architecture
    .slice(architecture.indexOf("## 1. "))
    .replace(/```mermaid\n[\s\S]*?```/g, () => {
      const i = n++;
      return `![${DIAGRAMS[i][1]}](/architecture/${path.basename(files[i])})`;
    });
})();
fs.writeFileSync(
  path.join(root, "apps/docs/architecture.md"),
  `---
outline: [2, 3]
---

<!-- Generated from ARCHITECTURE.md by scripts/render-architecture.mjs. Edit ARCHITECTURE.md, then run the script. -->

# Architecture

wcvm runs a Node.js project **inside one browser tab**, with no backend. This page explains how: which threads exist, how they talk to each other, and why it is built this way. The source of truth, with the diagrams as Mermaid, is [ARCHITECTURE.md](https://github.com/duyduc-dev/wcvm/blob/main/ARCHITECTURE.md).

${docsBody}`,
);

// The README copy: everything from "## 1." on, one heading level deeper, diagrams as images.
const body = (imageBase) => {
  let n = 0;
  return architecture
    .slice(architecture.indexOf("## 1. "))
    .replace(/```mermaid\n[\s\S]*?```/g, () => {
      const i = n++;
      return `![${DIAGRAMS[i][1]}](${imageBase}${files[i]})`;
    })
    .replace(/^(#{2,}) /gm, "#$1 ");
};

const section = (imageBase, docBase) => `${START}
## Architecture

How wcvm is built: which threads exist, how they talk, and why. The same text, with the diagrams as editable
Mermaid source, is [\`ARCHITECTURE.md\`](${docBase}ARCHITECTURE.md); the roadmap is [\`PLAN.md\`](${docBase}PLAN.md) and the
history behind each decision is [\`HISTORY.md\`](${docBase}HISTORY.md).

${body(imageBase)}
${END}
`;

for (const [readme, imageBase, docBase] of [["README.md", "", ""], ["packages/core/README.md", RAW, BLOB]]) {
  const file = path.join(root, readme);
  let text = fs.readFileSync(file, "utf8");
  const block = section(imageBase, docBase);
  if (text.includes(START)) text = text.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}\\n`), () => block);
  else {
    const at = text.indexOf("\n## Development");
    if (at === -1) throw new Error(`${readme} has no "## Development" heading to insert before`);
    text = `${text.slice(0, at + 1)}${block}\n${text.slice(at + 1)}`;
  }
  fs.writeFileSync(file, text);
}
console.log(`rendered ${files.length} diagrams, wrote the docs architecture page and updated both READMEs`);
