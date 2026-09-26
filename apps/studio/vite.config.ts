import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig, type Connect, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

function crossOriginIsolationHeaders(): Plugin {
  const middleware: Connect.NextHandleFunction = (_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  };

  return {
    name: "wcvm-cross-origin-isolation-headers",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    crossOriginIsolationHeaders(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
