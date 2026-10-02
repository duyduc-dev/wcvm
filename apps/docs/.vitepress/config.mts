import { defineConfig } from "vitepress";
import type { Plugin } from "vite";

const SITE = "https://docs.wcvmjs.com";
const STUDIO = "https://studio.wcvmjs.com";
const WEBSITE = "https://wcvmjs.com";

// The live demo boots wcvm, whose synchronous filesystem bridge needs a cross-origin isolated page. In
// production the headers come from public/_headers; this adds them to `vitepress dev`.
const isolationHeaders = (): Plugin => ({
  name: "wcvm-cross-origin-isolation-headers",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
});

export default defineConfig({
  title: "wcvm",
  titleTemplate: ":title - wcvm docs",
  description: "A WebContainer-style Node.js sandbox that runs entirely in the browser tab, in Web Workers, with no backend.",
  lang: "en-US",
  // README.md is a note for people editing the docs, not a page of the site.
  srcExclude: ["README.md"],
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE },

  vite: {
    plugins: [isolationHeaders()],
    // wcvm starts its workers from `new URL(..., import.meta.url)`: inlining them as data: URLs would break that.
    build: { assetsInlineLimit: 0 },
  },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo-mark.svg" }],
    ["meta", { name: "theme-color", content: "#5236E0" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "wcvm docs" }],
    ["meta", { property: "og:description", content: "Node.js in your browser tab. No backend." }],
    ["meta", { property: "og:image", content: `${SITE}/social-preview.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],

  themeConfig: {
    logo: "/logo-mark.svg",
    siteTitle: "wcvm",

    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Playground", link: "/playground" },
      { text: "Reference", link: "/reference/api", activeMatch: "/reference/" },
      { text: "Architecture", link: "/architecture" },
      // Each wcvm site opens the others in a new tab; the docs are often read next to Studio.
      { text: "Website", link: WEBSITE, target: "_blank", rel: "noopener noreferrer" },
      { text: "Studio", link: STUDIO, target: "_blank", rel: "noopener noreferrer" },
      { text: "npm", link: "https://www.npmjs.com/package/wcvm", target: "_blank", rel: "noopener noreferrer" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Quickstart", link: "/guide/getting-started" },
          { text: "Playground", link: "/playground" },
        ],
      },
      {
        text: "Building with wcvm",
        items: [
          { text: "Working with the file system", link: "/guide/files" },
          { text: "Running processes", link: "/guide/processes" },
          { text: "Preview a dev server", link: "/guide/preview" },
          { text: "Frameworks", link: "/guide/frameworks" },
        ],
      },
      {
        text: "Deploying",
        items: [
          { text: "Configuring headers", link: "/guide/headers" },
          { text: "Browser support", link: "/guide/browser-support" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Moving to wcvm",
        items: [{ text: "Migrating from WebContainers", link: "/guide/from-webcontainers" }],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Limitations", link: "/reference/limitations" },
        ],
      },
      { text: "Architecture", items: [{ text: "How wcvm is built", link: "/architecture" }] },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/duyduc-dev/wcvm" }],
    search: { provider: "local" },
    editLink: { pattern: "https://github.com/duyduc-dev/wcvm/edit/main/apps/docs/:path", text: "Edit this page on GitHub" },
    footer: { message: "Released under the ISC license.", copyright: "Copyright 2026 duyduc-dev" },
    outline: { level: [2, 3] },
  },
});
