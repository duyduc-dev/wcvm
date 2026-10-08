---
layout: home

hero:
  name: wcvm
  text: Node.js in your browser tab
  tagline: No backend. Real processes in Web Workers, Node's own runtime, npm install, and dev servers you can preview in an iframe.
  image:
    src: /logo-mark.svg
    alt: wcvm
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Open Studio
      link: https://studio.wcvmjs.com
    - theme: alt
      text: GitHub
      link: https://github.com/duyduc-dev/wcvm

features:
  - title: Real processes
    details: One Web Worker per PID, with stdout, stderr, stdin and kill(). A child process is another worker, supervised by the kernel.
  - title: Node's own runtime
    details: Node v24's lib/ is vendored unmodified on a small native layer written for the browser, so fs, streams, http, net, child_process, zlib, ESM and require(esm) behave like Node.
  - title: npm install, in the tab
    details: A built-in npm installs from the real registry into an in-memory filesystem, then npm run starts your scripts.
  - title: Dev servers in an iframe
    details: A Service Worker relays an iframe to a server running in the sandbox, WebSockets included, so Vite's hot reload works.
  - title: Persistent projects
    details: Optionally mirror the filesystem to the browser's Origin Private File System and restore it on the next load.
  - title: Frameworks that run
    details: Vite (React, Vue, Svelte, ...), Next.js, SvelteKit, React Router 7, Astro, Angular, Ember, Express and NestJS, each verified in real Chromium.
---

<div class="home-demo">

## Try it live

This runs real Node.js, inside this page. Click **Launch the editor**, edit the code and save: each process is a Web Worker, and nothing leaves your browser.

<EmbedPlayground picker example="script" />

</div>
