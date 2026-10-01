import { VITE_PIN, WASM_OVERRIDES } from "./vitePins";

// Ember (7.x) has no create-vite template; its own `ember new` blueprint (@ember/app-blueprint) is
// a Vite app driven by @embroider/vite. The files below are that blueprint's real output (generated
// with real Node, `ember new --blueprint @ember/app-blueprint`, then built and run for real in this
// sandbox - see the "Ember template" Playwright test), minus linting/testing tooling (eslint,
// prettier, stylelint, template-lint, qunit, testem - nothing a browser sandbox runs) and with
// four deliberate edits (the fourth: a Vite-style starter page - hero, logos, counter component - in place of the blueprint's bare "Welcome to Ember"):
// - `modulePrefix`/import paths use the fixed name "ember-app" instead of the project's own name
//   (the package.json "name" is fixed to match - see buildEmberPackageJson), so the project's own
//   name can never break the app.
// - `locationType: "hash"`: the preview relay serves the app under /__wcvm_preview__/<port>/, which
//   Ember's history router would see as an unknown route (UnrecognizedURLError). Same root cause
//   as tanstackRouterTemplateProject.ts's basepath fix, but a hash location needs no prefix at all.
// - `vite` pinned like every other template (vitePins.ts); esbuild/rollup swapped for their wasm
//   builds through `overrides`.
//
// How it runs, which is unusual: @embroider/vite doesn't transform Ember modules inside the dev
// server; `vite` first forks `ember build --watch` (broccoli + ember-cli, a large legacy CommonJS/
// ESM toolchain) into tmp/compat-prebuild, which itself shells out to `npx vite build`. That needed
// real wcvm capabilities (see HISTORY.md "Ember"): `require(esm)`, `npx`, `/tmp`, legacy package
// resolution, call-site file names. One environment setting is also required: JOBS=1 (Studio's
// shells set it, IdeController.ts) - broccoli-babel-transpiler otherwise starts a worker-process
// pool that never answers here.
const SHARED_FILES: [string, string][] = [
  ["config/environment.js", `'use strict';

module.exports = function (environment) {
  const ENV = {
    modulePrefix: 'ember-app',
    environment,
    rootURL: '/',
    locationType: 'hash',
    EmberENV: {
      EXTEND_PROTOTYPES: false,
      FEATURES: {
        // Here you can enable experimental features on an ember canary build
        // e.g. EMBER_NATIVE_DECORATOR_SUPPORT: true
      },
    },

    APP: {
      // Here you can pass flags/options to your application instance
      // when it is created
    },
  };

  if (environment === 'development') {
    // ENV.APP.LOG_RESOLVER = true;
    // ENV.APP.LOG_ACTIVE_GENERATION = true;
    // ENV.APP.LOG_TRANSITIONS = true;
    // ENV.APP.LOG_TRANSITIONS_INTERNAL = true;
    // ENV.APP.LOG_VIEW_LOOKUPS = true;
  }

  if (environment === 'test') {
    // Testem prefers this...
    ENV.locationType = 'none';

    // keep test console output quieter
    ENV.APP.LOG_ACTIVE_GENERATION = false;
    ENV.APP.LOG_VIEW_LOOKUPS = false;

    ENV.APP.rootElement = '#ember-testing';
    ENV.APP.autoboot = false;
  }

  if (environment === 'production') {
    // here you can enable a production-specific feature
  }

  return ENV;
};
`],
  ["config/optional-features.json", `{
  "application-template-wrapper": false,
  "default-async-observers": true,
  "jquery-integration": false,
  "template-only-glimmer-components": true,
  "no-implicit-route-model": true
}
`],
  ["config/targets.js", `'use strict';

const browsers = [
  'last 1 Chrome versions',
  'last 1 Firefox versions',
  'last 1 Safari versions',
];

module.exports = {
  browsers,
};
`],
  ["ember-cli-build.mjs", `import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmberApp from 'ember-cli/lib/broccoli/ember-app.js';
import { compatBuild } from '@embroider/compat';

export default async function (defaults) {
  const { setConfig } = await import('@warp-drive/core/build-config');
  const { buildOnce } = await import('@embroider/vite');

  const app = new EmberApp(defaults, {
    // Add options here
  });

  setConfig(app, dirname(fileURLToPath(import.meta.url)), {
    // this should be the most recent <major>.<minor> version for
    // which all deprecations have been fully resolved
    // and should be updated when that changes
    compatWith: '5.8',
    deprecations: {
      // ... list individual deprecations that have been resolved here
    },
  });

  return compatBuild(app, buildOnce);
}
`],
  ["index.html", `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Ember App</title>
    <meta name="description" content="">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" type="image/svg+xml" href="/ember.svg">

    {{content-for "head"}}

    <link integrity="" rel="stylesheet" href="/@embroider/virtual/vendor.css">
    <link integrity="" rel="stylesheet" href="/@embroider/virtual/app.css">

    {{content-for "head-footer"}}
  </head>
  <body>
    {{content-for "body"}}

    <script src="/@embroider/virtual/vendor.js"></script>
    <script type="module">
      import Application from './app/app';
      import environment from './app/config/environment';

      Application.create(environment.APP);
    </script>

    {{content-for "body-footer"}}
  </body>
</html>
`],
  ["vite.config.mjs", `import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';

export default defineConfig({
  plugins: [
    classicEmberSupport(),
    ember(),
    // extra plugins here
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
  ],
});
`],
  ["public/robots.txt", `# https://www.robotstxt.org/
User-agent: *
Disallow:
`],
  ["public/vite.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="77" height="47" fill="none" aria-labelledby="vite-logo-title" viewBox="0 0 77 47"><title id="vite-logo-title">Vite</title><style>.parenthesis{fill:#000}@media (prefers-color-scheme:dark){.parenthesis{fill:#fff}}</style><path fill="#9135ff" d="M40.151 45.71c-.663.844-2.02.374-2.02-.699V34.708a2.26 2.26 0 0 0-2.262-2.262H24.493c-.92 0-1.457-1.04-.92-1.788l7.479-10.471c1.07-1.498 0-3.578-1.842-3.578H15.443c-.92 0-1.456-1.04-.92-1.788l9.696-13.576c.213-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.472c-1.07 1.497 0 3.578 1.842 3.578h11.376c.944 0 1.474 1.087.89 1.83L40.153 45.712z"/><mask id="a" width="48" height="47" x="14" y="0" maskUnits="userSpaceOnUse" style="mask-type:alpha"><path fill="#000" d="M40.047 45.71c-.663.843-2.02.374-2.02-.699V34.708a2.26 2.26 0 0 0-2.262-2.262H24.389c-.92 0-1.457-1.04-.92-1.788l7.479-10.472c1.07-1.497 0-3.578-1.842-3.578H15.34c-.92 0-1.456-1.04-.92-1.788l9.696-13.575c.213-.297.556-.474.92-.474H53.93c.92 0 1.456 1.04.92 1.788L47.37 13.03c-1.07 1.498 0 3.578 1.842 3.578h11.376c.944 0 1.474 1.088.89 1.831L40.049 45.712z"/></mask><g mask="url(#a)"><g filter="url(#b)"><ellipse cx="5.508" cy="14.704" fill="#eee6ff" rx="5.508" ry="14.704" transform="rotate(269.814 20.96 11.29)scale(-1 1)"/></g><g filter="url(#c)"><ellipse cx="10.399" cy="29.851" fill="#eee6ff" rx="10.399" ry="29.851" transform="rotate(89.814 -16.902 -8.275)scale(1 -1)"/></g><g filter="url(#d)"><ellipse cx="5.508" cy="30.487" fill="#8900ff" rx="5.508" ry="30.487" transform="rotate(89.814 -19.197 -7.127)scale(1 -1)"/></g><g filter="url(#e)"><ellipse cx="5.508" cy="30.599" fill="#8900ff" rx="5.508" ry="30.599" transform="rotate(89.814 -25.928 4.177)scale(1 -1)"/></g><g filter="url(#f)"><ellipse cx="5.508" cy="30.599" fill="#8900ff" rx="5.508" ry="30.599" transform="rotate(89.814 -25.738 5.52)scale(1 -1)"/></g><g filter="url(#g)"><ellipse cx="14.072" cy="22.078" fill="#eee6ff" rx="14.072" ry="22.078" transform="rotate(93.35 31.245 55.578)scale(-1 1)"/></g><g filter="url(#h)"><ellipse cx="3.47" cy="21.501" fill="#8900ff" rx="3.47" ry="21.501" transform="rotate(89.009 35.419 55.202)scale(-1 1)"/></g><g filter="url(#i)"><ellipse cx="3.47" cy="21.501" fill="#8900ff" rx="3.47" ry="21.501" transform="rotate(89.009 35.419 55.202)scale(-1 1)"/></g><g filter="url(#j)"><ellipse cx="14.592" cy="9.743" fill="#8900ff" rx="4.407" ry="29.108" transform="rotate(39.51 14.592 9.743)"/></g><g filter="url(#k)"><ellipse cx="61.728" cy="-5.321" fill="#8900ff" rx="4.407" ry="29.108" transform="rotate(37.892 61.728 -5.32)"/></g><g filter="url(#l)"><ellipse cx="55.618" cy="7.104" fill="#00c2ff" rx="5.971" ry="9.665" transform="rotate(37.892 55.618 7.104)"/></g><g filter="url(#m)"><ellipse cx="12.326" cy="39.103" fill="#8900ff" rx="4.407" ry="29.108" transform="rotate(37.892 12.326 39.103)"/></g><g filter="url(#n)"><ellipse cx="12.326" cy="39.103" fill="#8900ff" rx="4.407" ry="29.108" transform="rotate(37.892 12.326 39.103)"/></g><g filter="url(#o)"><ellipse cx="49.857" cy="30.678" fill="#8900ff" rx="4.407" ry="29.108" transform="rotate(37.892 49.857 30.678)"/></g><g filter="url(#p)"><ellipse cx="52.623" cy="33.171" fill="#00c2ff" rx="5.971" ry="15.297" transform="rotate(37.892 52.623 33.17)"/></g></g><path d="M6.919 0c-9.198 13.166-9.252 33.575 0 46.789h6.215c-9.25-13.214-9.196-33.623 0-46.789zm62.424 0h-6.215c9.198 13.166 9.252 33.575 0 46.789h6.215c9.25-13.214 9.196-33.623 0-46.789" class="parenthesis"/><defs><filter id="b" width="60.045" height="41.654" x="-5.564" y="16.92" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="7.659"/></filter><filter id="c" width="90.34" height="51.437" x="-40.407" y="-6.762" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="7.659"/></filter><filter id="d" width="79.355" height="29.4" x="-35.435" y="2.801" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="e" width="79.579" height="29.4" x="-30.84" y="20.8" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="f" width="79.579" height="29.4" x="-29.307" y="21.949" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="g" width="74.749" height="58.852" x="29.961" y="-17.13" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="7.659"/></filter><filter id="h" width="61.377" height="25.362" x="37.754" y="3.055" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="i" width="61.377" height="25.362" x="37.754" y="3.055" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="j" width="56.045" height="63.649" x="-13.43" y="-22.082" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="k" width="54.814" height="64.646" x="34.321" y="-37.644" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="l" width="33.541" height="35.313" x="38.847" y="-10.552" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="m" width="54.814" height="64.646" x="-15.081" y="6.78" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="n" width="54.814" height="64.646" x="-15.081" y="6.78" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="o" width="54.814" height="64.646" x="22.45" y="-1.645" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter><filter id="p" width="39.409" height="43.623" x="32.919" y="11.36" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_2002_17286" stdDeviation="4.596"/></filter></defs></svg>
`],
  ["public/ember.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="#E04E39" d="M0 0v24h24V0H0zm12.29 4.38c1.66-.03 2.83.42 3.84 1.85 2.25 5.58-6 8.4-6 8.4s-.23 1.48 2.02 1.42c2.78 0 5.7-2.15 6.81-3.06a.66.66 0 01.9.05l.84.87a.66.66 0 01.01.9c-.72.8-2.42 2.46-4.97 3.53 0 0-4.26 1.97-7.13.1a4.95 4.95 0 01-2.38-3.83s-2.08-.11-3.42-.63c-1.33-.52.01-2.1.01-2.1s.42-.65 1.2 0 2.24.36 2.24.36c.13-1.03.35-2.38.98-3.81 1.34-3 3.38-4.01 5.05-4.05zm.33 2.8c-1.1.07-2.8 1.78-2.88 4.93 0 0 .75.23 2.41-.91 1.67-1.14 2-2.97 1.11-3.81a.82.82 0 00-.64-.21Z"/></svg>
`],
  ["app/styles/app.css", `/* Ember supports plain CSS out of the box. More info: https://cli.emberjs.com/release/advanced-use/stylesheets/ */
:root {
  --text: #6b6375;
  --text-h: #08060d;
  --bg: #fff;
  --border: #e5e4e7;
  --code-bg: #f4f3ec;
  --accent: #e04e39;
  --accent-bg: rgba(224, 78, 57, 0.1);
  --accent-border: rgba(224, 78, 57, 0.5);
  --shadow: rgba(0, 0, 0, 0.1) 0 10px 15px -3px, rgba(0, 0, 0, 0.05) 0 4px 6px -2px;
  --sans: system-ui, 'Segoe UI', Roboto, sans-serif;
  --mono: ui-monospace, Consolas, monospace;

  font: 18px/145% var(--sans);
  letter-spacing: 0.18px;
  color-scheme: light dark;
  color: var(--text);
  background: var(--bg);
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #9ca3af;
    --text-h: #f3f4f6;
    --bg: #16171d;
    --border: #2e303a;
    --code-bg: #1f2028;
    --accent: #ff7a66;
    --accent-bg: rgba(255, 122, 102, 0.15);
    --accent-border: rgba(255, 122, 102, 0.5);
    --shadow: rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px;
  }
}

body {
  margin: 0;
}

h1 {
  font-size: 56px;
  font-weight: 500;
  letter-spacing: -1.68px;
  margin: 32px 0;
  color: var(--text-h);
}

p {
  margin: 0;
}

code {
  font-family: var(--mono);
  font-size: 15px;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--text-h);
  background: var(--code-bg);
}

.app {
  width: 1126px;
  max-width: 100%;
  min-height: 100svh;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-inline: 1px solid var(--border);
  text-align: center;
}

.hero {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 32px 20px;
}

.logos {
  display: flex;
  align-items: center;
  gap: 32px;
}

.logos img {
  height: 64px;
  width: auto;
}

.counter {
  font: inherit;
  font-family: var(--mono);
  color: var(--accent);
  background: var(--accent-bg);
  border: 2px solid transparent;
  border-radius: 6px;
  padding: 6px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.3s;
}

.counter:hover {
  border-color: var(--accent-border);
}

.links {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 24px 20px;
  border-top: 1px solid var(--border);
}

.links a {
  color: var(--text-h);
  text-decoration: none;
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--code-bg);
  transition: box-shadow 0.3s;
}

.links a:hover {
  box-shadow: var(--shadow);
}

@media (max-width: 1024px) {
  :root { font-size: 16px; }
  h1 { font-size: 36px; margin: 20px 0; }
}
`],
  [".env.development", `# This file is committed to git and should not contain any secrets.
# 
# Vite recommends using .env.local or .env.[mode].local if you need to manage secrets
# SEE: https://vite.dev/guide/env-and-mode.html#env-files for more information.


# Default NODE_ENV with vite build --mode=test is production
NODE_ENV=development
`],
  [".gitignore", `# compiled output
/dist/
/tmp/

# dependencies
/node_modules/

# misc
*.local
/.pnp*
/.eslintcache
/coverage/
/npm-debug.log*
/testem.log
/yarn-error.log

# broccoli-debug
/DEBUG/
`],
];

const JS_FILES: [string, string][] = [
  ["app/app.js", `import '@warp-drive/ember/install';
import Application from '@ember/application';
import compatModules from '@embroider/virtual/compat-modules';
import Resolver from 'ember-resolver';
import loadInitializers from 'ember-load-initializers';
import config from 'ember-app/config/environment';
import { importSync, isDevelopingApp, macroCondition } from '@embroider/macros';
import setupInspector from '@embroider/legacy-inspector-support/ember-source-4.12';

if (macroCondition(isDevelopingApp())) {
  importSync('./deprecation-workflow');
}

export default class App extends Application {
  modulePrefix = config.modulePrefix;
  podModulePrefix = config.podModulePrefix;
  Resolver = Resolver.withModules(compatModules);
  inspector = setupInspector(this);
}

loadInitializers(App, config.modulePrefix, compatModules);
`],
  ["app/router.js", `import EmberRouter from '@embroider/router';
import config from 'ember-app/config/environment';

export default class Router extends EmberRouter {
  location = config.locationType;
  rootURL = config.rootURL;
}

Router.map(function () {});
`],
  ["app/deprecation-workflow.js", `import setupDeprecationWorkflow from 'ember-cli-deprecation-workflow';

/**
 * Docs: https://github.com/ember-cli/ember-cli-deprecation-workflow
 */
setupDeprecationWorkflow({
  /**
    false by default, but if a developer / team wants to be more aggressive about being proactive with
    handling their deprecations, this should be set to "true"
  */
  throwOnUnhandled: false,
  workflow: [
    /* ... handlers ... */
    /* to generate this list, run your app for a while (or run the test suite),
     * and then run in the browser console:
     *
     *    deprecationWorkflow.flushDeprecations()
     *
     * And copy the handlers here
     */
    /* example: */
    /* { handler: 'silence', matchId: 'template-action' }, */
  ],
});
`],
  ["app/config/environment.js", `import loadConfigFromMeta from '@embroider/config-meta-loader';
import { assert } from '@ember/debug';

const config = loadConfigFromMeta('ember-app');

assert(
  'config is not an object',
  typeof config === 'object' && config !== null,
);
assert(
  'modulePrefix was not detected on your config',
  'modulePrefix' in config && typeof config.modulePrefix === 'string',
);
assert(
  'locationType was not detected on your config',
  'locationType' in config && typeof config.locationType === 'string',
);
assert(
  'rootURL was not detected on your config',
  'rootURL' in config && typeof config.rootURL === 'string',
);
assert(
  'APP was not detected on your config',
  'APP' in config && typeof config.APP === 'object',
);

export default config;
`],
  ["app/services/store.js", `import { useLegacyStore } from '@warp-drive/legacy';
import { JSONAPICache } from '@warp-drive/json-api';

const Store = useLegacyStore({
  linksMode: false,
  cache: JSONAPICache,
  handlers: [
    // -- your handlers here
  ],
  schemas: [
    // -- your schemas here
  ],
});

export default Store;
`],
  ["app/templates/application.gjs", `import { pageTitle } from 'ember-page-title';
import Counter from 'ember-app/components/counter';

<template>
  {{pageTitle "Ember App"}}

  <div class="app">
    <section class="hero">
      <div class="logos">
        <img src="/ember.svg" alt="Ember logo" />
        <img src="/vite.svg" alt="Vite logo" />
      </div>
      <div>
        <h1 id="title">Get started</h1>
        <p>
          Edit <code>app/templates/application.gjs</code> and save to test
          <code>HMR</code>
        </p>
      </div>
      <Counter />
    </section>

    <nav class="links">
      <a href="https://guides.emberjs.com/" target="_blank" rel="noreferrer">Ember Guides</a>
      <a href="https://cli.emberjs.com/" target="_blank" rel="noreferrer">Ember CLI</a>
      <a href="https://vite.dev/" target="_blank" rel="noreferrer">Vite</a>
    </nav>
  </div>

  {{outlet}}
</template>
`],
  ["app/components/counter.gjs", `import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';

export default class Counter extends Component {
  @tracked count = 0;

  increment = () => {
    this.count++;
  };

  <template>
    <button class="counter" type="button" {{on "click" this.increment}}>
      Count is {{this.count}}
    </button>
  </template>
}
`],
  ["babel.config.mjs", `import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  babelCompatSupport,
  templateCompatSupport,
} from '@embroider/compat/babel';

export default {
  plugins: [
    [
      'babel-plugin-ember-template-compilation',
      {
        enableLegacyModules: [
          'ember-cli-htmlbars',
          'ember-cli-htmlbars-inline-precompile',
          'htmlbars-inline-precompile',
        ],
        transforms: [...templateCompatSupport()],
      },
    ],
    [
      'module:decorator-transforms',
      {
        runtime: {
          import: fileURLToPath(
            import.meta.resolve('decorator-transforms/runtime-esm'),
          ),
        },
      },
    ],
    [
      '@babel/plugin-transform-runtime',
      {
        absoluteRuntime: dirname(fileURLToPath(import.meta.url)),
        useESModules: true,
        regenerator: false,
      },
    ],
    ...babelCompatSupport(),
  ],

  generatorOpts: {
    compact: false,
  },
};
`],
  [".ember-cli", `{
  /**
    Setting \`isTypeScriptProject\` to true will force the blueprint generators to generate TypeScript
    rather than JavaScript by default, when a TypeScript version of a given blueprint is available.
  */
  "isTypeScriptProject": false,

  /**
    Setting \`componentAuthoringFormat\` to "strict" will force the blueprint generators to generate GJS
    or GTS files for the component and the component rendering test. "loose" is the default.
  */
  "componentAuthoringFormat": "strict",

  /**
    Setting \`routeAuthoringFormat\` to "strict" will force the blueprint generators to generate GJS
    or GTS templates for routes. "loose" is the default
  */
  "routeAuthoringFormat": "strict"
}
`],
];

const TS_FILES: [string, string][] = [
  ["app/app.ts", `import '@warp-drive/ember/install';
import Application from '@ember/application';
import compatModules from '@embroider/virtual/compat-modules';
import Resolver from 'ember-resolver';
import loadInitializers from 'ember-load-initializers';
import config from 'ember-app/config/environment';
import { importSync, isDevelopingApp, macroCondition } from '@embroider/macros';
import setupInspector from '@embroider/legacy-inspector-support/ember-source-4.12';

if (macroCondition(isDevelopingApp())) {
  importSync('./deprecation-workflow');
}

export default class App extends Application {
  modulePrefix = config.modulePrefix;
  podModulePrefix = config.podModulePrefix;
  Resolver = Resolver.withModules(compatModules);
  inspector = setupInspector(this);
}

loadInitializers(App, config.modulePrefix, compatModules);
`],
  ["app/router.ts", `import EmberRouter from '@embroider/router';
import config from 'ember-app/config/environment';

export default class Router extends EmberRouter {
  location = config.locationType;
  rootURL = config.rootURL;
}

Router.map(function () {
  // Add route declarations here
});
`],
  ["app/deprecation-workflow.ts", `import setupDeprecationWorkflow from 'ember-cli-deprecation-workflow';

/**
 * Docs: https://github.com/ember-cli/ember-cli-deprecation-workflow
 */
setupDeprecationWorkflow({
  /**
    false by default, but if a developer / team wants to be more aggressive about being proactive with
    handling their deprecations, this should be set to "true"
  */
  throwOnUnhandled: false,
  workflow: [
    /* ... handlers ... */
    /* to generate this list, run your app for a while (or run the test suite),
     * and then run in the browser console:
     *
     *    deprecationWorkflow.flushDeprecations()
     *
     * And copy the handlers here
     */
    /* example: */
    /* { handler: 'silence', matchId: 'template-action' }, */
  ],
});
`],
  ["app/config/environment.ts", `import loadConfigFromMeta from '@embroider/config-meta-loader';
import { assert } from '@ember/debug';

const config = loadConfigFromMeta('ember-app') as unknown;

assert(
  'config is not an object',
  typeof config === 'object' && config !== null,
);
assert(
  'modulePrefix was not detected on your config',
  'modulePrefix' in config && typeof config.modulePrefix === 'string',
);
assert(
  'locationType was not detected on your config',
  'locationType' in config && typeof config.locationType === 'string',
);
assert(
  'rootURL was not detected on your config',
  'rootURL' in config && typeof config.rootURL === 'string',
);
assert(
  'APP was not detected on your config',
  'APP' in config && typeof config.APP === 'object',
);

export default config as {
  modulePrefix: string;
  podModulePrefix?: string;
  locationType: string;
  rootURL: string;
  APP: Record<string, unknown>;
} & Record<string, unknown>;
`],
  ["app/services/store.ts", `import { useLegacyStore } from '@warp-drive/legacy';
import { JSONAPICache } from '@warp-drive/json-api';

const Store = useLegacyStore({
  linksMode: false,
  cache: JSONAPICache,
  handlers: [
    // -- your handlers here
  ],
  schemas: [
    // -- your schemas here
  ],
});

type Store = InstanceType<typeof Store>;

export default Store;
`],
  ["app/templates/application.gts", `import { pageTitle } from 'ember-page-title';
import Counter from 'ember-app/components/counter';

<template>
  {{pageTitle "Ember App"}}

  <div class="app">
    <section class="hero">
      <div class="logos">
        <img src="/ember.svg" alt="Ember logo" />
        <img src="/vite.svg" alt="Vite logo" />
      </div>
      <div>
        <h1 id="title">Get started</h1>
        <p>
          Edit <code>app/templates/application.gts</code> and save to test
          <code>HMR</code>
        </p>
      </div>
      <Counter />
    </section>

    <nav class="links">
      <a href="https://guides.emberjs.com/" target="_blank" rel="noreferrer">Ember Guides</a>
      <a href="https://cli.emberjs.com/" target="_blank" rel="noreferrer">Ember CLI</a>
      <a href="https://vite.dev/" target="_blank" rel="noreferrer">Vite</a>
    </nav>
  </div>

  {{outlet}}
</template>
`],
  ["app/components/counter.gts", `import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';

export default class Counter extends Component {
  @tracked count = 0;

  increment = () => {
    this.count++;
  };

  <template>
    <button class="counter" type="button" {{on "click" this.increment}}>
      Count is {{this.count}}
    </button>
  </template>
}
`],
  ["babel.config.mjs", `import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  babelCompatSupport,
  templateCompatSupport,
} from '@embroider/compat/babel';

export default {
  plugins: [
    [
      '@babel/plugin-transform-typescript',
      {
        allExtensions: true,
        onlyRemoveTypeImports: true,
        allowDeclareFields: true,
      },
    ],
    [
      'babel-plugin-ember-template-compilation',
      {
        enableLegacyModules: [
          'ember-cli-htmlbars',
          'ember-cli-htmlbars-inline-precompile',
          'htmlbars-inline-precompile',
        ],
        transforms: [...templateCompatSupport()],
      },
    ],
    [
      'module:decorator-transforms',
      {
        runtime: {
          import: fileURLToPath(
            import.meta.resolve('decorator-transforms/runtime-esm'),
          ),
        },
      },
    ],
    [
      '@babel/plugin-transform-runtime',
      {
        absoluteRuntime: dirname(fileURLToPath(import.meta.url)),
        useESModules: true,
        regenerator: false,
      },
    ],
    ...babelCompatSupport(),
  ],

  generatorOpts: {
    compact: false,
  },
};
`],
  [".ember-cli", `{
  /**
    Setting \`isTypeScriptProject\` to true will force the blueprint generators to generate TypeScript
    rather than JavaScript by default, when a TypeScript version of a given blueprint is available.
  */
  "isTypeScriptProject": true,

  /**
    Setting \`componentAuthoringFormat\` to "strict" will force the blueprint generators to generate GJS
    or GTS files for the component and the component rendering test. "loose" is the default.
  */
  "componentAuthoringFormat": "strict",

  /**
    Setting \`routeAuthoringFormat\` to "strict" will force the blueprint generators to generate GJS
    or GTS templates for routes. "loose" is the default
  */
  "routeAuthoringFormat": "strict"
}
`],
  ["tsconfig.json", `{
  "extends": "@ember/app-tsconfig",
  "include": ["app", "tests", "types"],
  "compilerOptions": {
    "allowJs": true,
    "paths": {
      "ember-app/tests/*": ["./tests/*"],
      "ember-app/*": ["./app/*"],
      "*": ["./types/*"]
    },
    "types": [
      "ember-source/types",
      "@embroider/core/virtual",
      "vite/client",
      "@glint/ember-tsc/types"
    ]
  }
}
`],
];

const BASE_DEV_DEPENDENCIES: Record<string, string> = {
  "@babel/core": "^7.29.7",
  "@babel/plugin-transform-runtime": "^7.29.7",
  "@babel/runtime": "^7.29.7",
  "@ember/optional-features": "^3.0.0",
  "@ember/string": "^4.0.1",
  "@embroider/compat": "^4.1.25",
  "@embroider/config-meta-loader": "^1.0.0",
  "@embroider/core": "^4.6.7",
  "@embroider/legacy-inspector-support": "^0.1.3",
  "@embroider/macros": "^1.21.1",
  "@embroider/router": "^3.0.6",
  "@embroider/vite": "^1.7.13",
  "@glimmer/component": "^2.1.1",
  "@rollup/plugin-babel": "^7.1.0",
  "@warp-drive/core": "~5.8.2",
  "@warp-drive/ember": "~5.8.2",
  "@warp-drive/json-api": "~5.8.2",
  "@warp-drive/legacy": "~5.8.2",
  "@warp-drive/utilities": "~5.8.2",
  "babel-plugin-ember-template-compilation": "^4.0.0",
  "decorator-transforms": "^2.4.0",
  "ember-cli": "~7.3.0",
  "ember-cli-babel": "^8.3.2",
  "ember-cli-deprecation-workflow": "^4.0.1",
  "ember-load-initializers": "^3.0.1",
  "ember-modifier": "^4.3.0",
  "ember-page-title": "^9.0.3",
  "ember-resolver": "^13.2.0",
  "ember-source": "~7.3.0",
  "globals": "^16.5.0"
};

const TS_DEV_DEPENDENCIES: Record<string, string> = {
  "@babel/plugin-transform-typescript": "^7.29.7",
  "@ember/app-tsconfig": "^2.0.0",
  "@glint/ember-tsc": "^1.11.4",
  "@glint/template": "^1.9.0",
  "@types/rsvp": "^4.0.9",
  "typescript": "^6.0.3"
};

/** Every file of the project (the TypeScript variant swaps the .js/.gjs files for .ts/.gts ones and
 *  adds tsconfig.json). */
export const buildEmberFiles = (typescript: boolean): [string, string][] => [
  ...SHARED_FILES,
  ...(typescript ? TS_FILES : JS_FILES),
];

/** The project's package.json (as an object) - `vite` pinned, esbuild/rollup swapped for wasm. */
export const buildEmberPackageJson = (typescript: boolean) => ({
  // Fixed, NOT the project's name: `import ... from "ember-app/config/environment"` resolves through
  // this package's own "exports" self-reference, which only works when "name" matches the prefix.
  // (templateCache.ts is told to leave it alone when cloning.)
  name: "ember-app",
  version: "0.0.0",
  private: true,
  exports: { "./tests/*": "./tests/*", "./*": "./app/*" },
  scripts: { dev: "vite", start: "vite", build: "vite build" },
  devDependencies: { ...BASE_DEV_DEPENDENCIES, ...(typescript ? TS_DEV_DEPENDENCIES : {}), vite: VITE_PIN },
  overrides: WASM_OVERRIDES,
  ember: { edition: "octane" },
});
