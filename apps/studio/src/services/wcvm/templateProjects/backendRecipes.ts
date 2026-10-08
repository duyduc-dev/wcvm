// Express (JavaScript / TypeScript) and NestJS starters, checked in real Chromium against
// the real npm registry (install, build, start, and the server answering through the preview relay).
//
// Two choices come from what this sandbox can't run:
//  - TypeScript is compiled with `tsc` and the output is run with `node`. `tsx` / `ts-node` need a
//    native esbuild, and Node's own type stripping isn't available - so there is no watch-and-rerun;
//    `npm run dev` builds once and starts, and a rerun picks up edits.
//  - NestJS is run the same way (`tsc -p tsconfig.build.json && node dist/main`), not through
//    `@nestjs/cli`: `nest start` loads `@inquirer/core`, which needs `AsyncLocalStorage`, and that
//    needs `internal/promise_hooks`, which wcvm doesn't vendor yet. The CLI is therefore left out
//    of the project's dependencies (it also trims about a third off the install).

export type BackendKind = "express" | "express-ts" | "nestjs";

/** A small page every backend serves at `/`, so the otherwise headless server has something to
 * look at in the preview. It calls `GET api/hello` - RELATIVE, so it resolves under the preview
 * relay's `/__studio_preview__/<port>/` prefix as well as on a plain host. */
const demoHtml = (name: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, #1b2333, #0a0a0a); color: #e5e7eb; padding: 2rem; }
      main { width: 100%; max-width: 560px; }
      .eyebrow { color: #7c9cff; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 .4rem; }
      h1 { margin: 0 0 .3rem; font-size: 1.85rem; }
      .sub { color: #9ca3af; margin: 0 0 1.5rem; line-height: 1.5; }
      .card { background: #10131a; border: 1px solid #232a36; border-radius: 14px; padding: 1.25rem; }
      .endpoint { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: #9ca3af; margin-bottom: 1rem; }
      code { background: #1b212c; padding: .15rem .45rem; border-radius: 6px; color: #cbd5e1; }
      button { appearance: none; border: 0; cursor: pointer; width: 100%; padding: .75rem 1rem; font-size: .95rem; font-weight: 600;
        border-radius: 10px; color: #fff; background: linear-gradient(180deg, #4f7cff, #3b5cf0); }
      button:hover { filter: brightness(1.08); }
      button:disabled { opacity: .6; cursor: progress; }
      .status { margin: 1rem 0 .5rem; font-size: .82rem; font-weight: 600; min-height: 1.1rem; }
      .status.ok { color: #4ade80; }
      .status.err { color: #f87171; }
      pre { margin: 0; background: #0b0e14; border: 1px solid #232a36; border-radius: 10px; padding: .85rem;
        overflow: auto; font-size: .82rem; line-height: 1.5; color: #d1d5db; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">wcvm</p>
      <h1>${name}</h1>
      <p class="sub">This server is running entirely in your browser. Click the button to call its API.</p>
      <div class="card">
        <div class="endpoint">Endpoint <code>GET /api/hello</code></div>
        <button id="call">Call GET /api/hello</button>
        <p class="status" id="status"></p>
        <pre id="out">Response will appear here.</pre>
      </div>
    </main>
    <script>
      (function () {
        var btn = document.getElementById("call");
        var out = document.getElementById("out");
        var statusEl = document.getElementById("status");
        btn.addEventListener("click", function () {
          btn.disabled = true;
          statusEl.textContent = "";
          statusEl.className = "status";
          var t0 = performance.now();
          fetch("api/hello", { headers: { accept: "application/json" } })
            .then(function (r) { return r.text().then(function (body) { return { res: r, body: body }; }); })
            .then(function (o) {
              statusEl.textContent = o.res.status + " " + o.res.statusText + " \\u00b7 " + Math.round(performance.now() - t0) + " ms";
              statusEl.className = "status " + (o.res.ok ? "ok" : "err");
              var pretty = o.body;
              try { pretty = JSON.stringify(JSON.parse(o.body), null, 2); } catch (e) {}
              out.textContent = pretty;
            })
            .catch(function (err) {
              statusEl.textContent = "Request failed";
              statusEl.className = "status err";
              out.textContent = String((err && err.message) || err);
            })
            .finally(function () { btn.disabled = false; });
        });
      })();
    </script>
  </body>
</html>
`;

const GITIGNORE = "node_modules\ndist\n";

const readme = (title: string, dev: string): string => `# ${title}

A server running entirely in your browser (wcvm).

\`\`\`bash
${dev}
\`\`\`

The preview opens when the server starts listening. It serves a small page at \`/\` and a JSON
endpoint at \`GET /api/hello\`.
`;

export interface IBackendRecipe {
  /** Shown in the picker's progress message. */
  label: string;
  files: [path: string, contents: string][];
  /** `name` is filled in with the project's own name. */
  packageJson: Record<string, unknown>;
}

const EXPRESS_TS_CONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["src"]
}
`;

const expressJs: IBackendRecipe = {
  label: "Express",
  packageJson: {
    version: "1.0.0",
    private: true,
    type: "commonjs",
    scripts: { start: "node src/index.js", dev: "node src/index.js" },
    dependencies: { express: "^4.21.0" },
  },
  files: [
    [
      "src/index.js",
      `const express = require("express");

const app = express();
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(demoHtml("Express"))};

app.get("/", (_req, res) => {
  res.type("html").send(html);
});

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello, world!" });
});

app.listen(port, () => {
  console.log(\`Express listening on http://localhost:\${port}\`);
});
`,
    ],
    [".gitignore", GITIGNORE],
    ["README.md", readme("Express (JavaScript)", "npm run dev")],
  ],
};

const expressTs: IBackendRecipe = {
  label: "Express",
  packageJson: {
    version: "1.0.0",
    private: true,
    scripts: { build: "tsc", start: "node dist/index.js", dev: "tsc && node dist/index.js" },
    dependencies: { express: "^4.21.0" },
    devDependencies: { "@types/express": "^4.17.21", "@types/node": "^22.10.0", typescript: "^5.7.0" },
  },
  files: [
    ["tsconfig.json", EXPRESS_TS_CONFIG],
    [
      "src/index.ts",
      `import express, { Request, Response } from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(demoHtml("Express"))};

app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(html);
});

app.get("/api/hello", (_req: Request, res: Response) => {
  res.json({ message: "Hello, world!" });
});

app.listen(port, () => {
  console.log(\`Express listening on http://localhost:\${port}\`);
});
`,
    ],
    [".gitignore", GITIGNORE],
    ["README.md", readme("Express (TypeScript)", "npm run dev   # tsc, then node dist/index.js")],
  ],
};

const nestjs: IBackendRecipe = {
  label: "NestJS",
  packageJson: {
    version: "0.0.1",
    private: true,
    license: "UNLICENSED",
    scripts: {
      build: "tsc -p tsconfig.build.json",
      start: "node dist/main",
      dev: "tsc -p tsconfig.build.json && node dist/main",
    },
    dependencies: {
      "@nestjs/common": "^11.0.1",
      "@nestjs/core": "^11.0.1",
      "@nestjs/platform-express": "^11.0.1",
      "reflect-metadata": "^0.2.2",
      rxjs: "^7.8.1",
    },
    devDependencies: { "@types/node": "^22.10.7", typescript: "^5.7.3" },
  },
  files: [
    [
      "tsconfig.json",
      `{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": false
  }
}
`,
    ],
    [
      "tsconfig.build.json",
      `{
  "extends": "./tsconfig.json",
  "include": ["src"],
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
`,
    ],
    [
      "src/main.ts",
      `import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`,
    ],
    [
      "src/app.module.ts",
      `import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`,
    ],
    [
      "src/app.controller.ts",
      `import { Controller, Get, Header } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header("Content-Type", "text/html")
  getHome(): string {
    return this.appService.getHome();
  }

  @Get("api/hello")
  getHello(): { message: string } {
    return { message: "Hello, world!" };
  }
}
`,
    ],
    [
      "src/app.service.ts",
      `import { Injectable } from "@nestjs/common";

const html = ${JSON.stringify(demoHtml("NestJS"))};

@Injectable()
export class AppService {
  getHome(): string {
    return html;
  }
}
`,
    ],
    [".gitignore", GITIGNORE],
    ["README.md", readme("NestJS", "npm run dev   # tsc, then node dist/main")],
  ],
};

export const BACKEND_RECIPES: Record<BackendKind, IBackendRecipe> = {
  express: expressJs,
  "express-ts": expressTs,
  nestjs,
};
