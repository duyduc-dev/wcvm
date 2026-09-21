// Preload (`--import`) that installs tsResolveHook.mjs in a worker thread.
import { register } from "node:module";

register("./tsResolveHook.mjs", import.meta.url);
