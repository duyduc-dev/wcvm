<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { IProcess } from "wcvm";
import { EXAMPLES } from "./examples";
import { getWcvm, isolated } from "./wcvm";

const props = withDefaults(defineProps<{ example?: string; picker?: boolean }>(), { example: "hello", picker: false });

const STUDIO = "https://studio.wcvmjs.com";
const TIME_LIMIT_MS = 15_000;

type Status = "idle" | "booting" | "ready" | "running" | "unsupported" | "error";
interface ISegment {
  text: string;
  kind: "out" | "err" | "info";
}

const selected = ref(props.example);
const example = computed(() => EXAMPLES.find((e) => e.id === selected.value) ?? EXAMPLES[0]);
const code = ref(example.value.code);
const status = ref<Status>("idle");
const segments = ref<ISegment[]>([]);
const root = ref<HTMLElement | null>(null);
const terminal = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const gutter = ref<HTMLElement | null>(null);

let proc: IProcess | undefined;
let runId = 0;
let observer: IntersectionObserver | undefined;

// ── highlighting: a small tokenizer, enough for the examples (no dependency) ─────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|\b(import|from|export|default|const|let|var|function|return|if|else|for|while|do|break|continue|switch|case|await|async|new|class|extends|of|in|try|catch|finally|throw|typeof|instanceof|true|false|null|undefined|this)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\()/g;

const highlight = (source: string): string => {
  let out = "";
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    out += esc(source.slice(last, m.index));
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : m[4] ? "n" : "f";
    out += `<span class="t-${cls}">${esc(m[0])}</span>`;
    last = (m.index ?? 0) + m[0].length;
  }
  // The trailing newline keeps the overlay as tall as the textarea when the code ends with a blank line.
  return out + esc(source.slice(last)) + "\n";
};
const highlighted = computed(() => highlight(code.value));
const lineCount = computed(() => code.value.split("\n").length);

// ── the terminal ────────────────────────────────────────────────────────────────────────────────
const append = (text: string, kind: ISegment["kind"]) => {
  const last = segments.value[segments.value.length - 1];
  if (last && last.kind === kind) last.text += text;
  else segments.value.push({ text, kind });
  void nextTick(() => {
    if (terminal.value) terminal.value.scrollTop = terminal.value.scrollHeight;
  });
};

const pump = async (stream: ReadableStream<Uint8Array>, kind: ISegment["kind"], id: number) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (id === runId && value) append(decoder.decode(value, { stream: true }), kind);
  }
};

// ── running ─────────────────────────────────────────────────────────────────────────────────────
const ensureWcvm = async () => {
  if (status.value === "idle") status.value = "booting";
  try {
    const wc = await getWcvm();
    if (status.value === "booting") status.value = "ready";
    return wc;
  } catch (error) {
    status.value = "error";
    append(`Could not start wcvm: ${error instanceof Error ? error.message : String(error)}\n`, "err");
    throw error;
  }
};

const stop = () => {
  runId++;
  proc?.kill();
  proc = undefined;
};

const run = async () => {
  if (status.value === "unsupported" || status.value === "booting") return;
  stop();
  const id = runId;
  segments.value = [];
  const wc = await ensureWcvm().catch(() => undefined);
  if (!wc || id !== runId) return;

  status.value = "running";
  const started = performance.now();
  const timer = setTimeout(() => {
    if (id === runId) {
      append(`\n[stopped after ${TIME_LIMIT_MS / 1000}s]\n`, "info");
      stop();
      status.value = "ready";
    }
  }, TIME_LIMIT_MS);
  try {
    await wc.fs.writeFile(`/demo/${example.value.file}`, code.value);
    const child = await wc.spawn("node", [example.value.file], { cwd: "/demo" });
    proc = child;
    const pumps = [pump(child.stdout, "out", id), pump(child.stderr, "err", id)];
    const { exitCode } = await child.exit;
    await Promise.all(pumps);
    if (id === runId) {
      append(`\n[exited with code ${exitCode} in ${Math.round(performance.now() - started)} ms]\n`, "info");
      status.value = "ready";
    }
  } catch (error) {
    if (id === runId) {
      append(`\n${error instanceof Error ? error.message : String(error)}\n`, "err");
      status.value = "ready";
    }
  } finally {
    clearTimeout(timer);
    if (id === runId) proc = undefined;
  }
};

const reset = () => {
  stop();
  code.value = example.value.code;
  segments.value = [];
  if (status.value === "running") status.value = "ready";
};

watch(selected, () => reset());

// ── the editor ──────────────────────────────────────────────────────────────────────────────────
const onScroll = (event: Event) => {
  const area = event.target as HTMLTextAreaElement;
  if (overlay.value) {
    overlay.value.scrollTop = area.scrollTop;
    overlay.value.scrollLeft = area.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = area.scrollTop;
};

const onKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void run();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const area = event.target as HTMLTextAreaElement;
    const { selectionStart: from, selectionEnd: to } = area;
    code.value = `${code.value.slice(0, from)}  ${code.value.slice(to)}`;
    void nextTick(() => area.setSelectionRange(from + 2, from + 2));
  }
};

onMounted(() => {
  if (!isolated()) {
    status.value = "unsupported";
    return;
  }
  // Boot when the demo scrolls into view, not on every page load: it starts several workers.
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer?.disconnect();
      void ensureWcvm().catch(() => undefined);
    }
  });
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  stop();
});

const dot = computed(() => ({ idle: "off", booting: "wait", ready: "on", running: "run", unsupported: "off", error: "err" })[status.value]);
const placeholder = computed(() => {
  if (status.value === "unsupported") return "Live demo needs a cross-origin isolated page, which this page is not. Open it in Studio instead.";
  if (status.value === "booting") return "Starting wcvm...";
  if (status.value === "error") return "";
  return `Ready. Edit ${example.value.file} and press Run.`;
});
</script>

<template>
  <div ref="root" class="demo">
    <div class="demo-head">
      <span class="dot" :class="dot" aria-hidden="true"></span>
      <strong>Live Node terminal</strong>
      <select v-if="picker" v-model="selected" class="pick" aria-label="Example">
        <option v-for="e in EXAMPLES" :key="e.id" :value="e.id">{{ e.title }}</option>
      </select>
      <a class="studio" :href="STUDIO" target="_blank" rel="noopener">Open in Studio &#8599;</a>
    </div>

    <div class="demo-bar">
      <span class="dot" :class="dot" aria-hidden="true"></span>
      <code>node - {{ example.file }}</code>
      <span class="spacer"></span>
      <button class="ghost" type="button" :disabled="status === 'running'" @click="reset">Reset</button>
      <button v-if="status === 'running'" class="run stop" type="button" @click="stop(); status = 'ready'">&#9632; Stop</button>
      <button v-else class="run" type="button" :disabled="status === 'unsupported' || status === 'booting'" @click="run">&#9654; Run</button>
    </div>

    <div class="demo-body">
      <div class="pane editor">
        <div class="pane-title"><span>{{ example.file }}</span><span class="hint">Cmd+S / Ctrl+S to run</span></div>
        <div class="editor-area">
          <div ref="gutter" class="gutter" aria-hidden="true"><div v-for="n in lineCount" :key="n">{{ n }}</div></div>
          <div class="code">
            <pre ref="overlay" class="hl" aria-hidden="true" v-html="highlighted"></pre>
            <textarea
              v-model="code"
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
              aria-label="Code editor"
              wrap="off"
              @scroll="onScroll"
              @keydown="onKeydown"
            ></textarea>
          </div>
        </div>
      </div>

      <div class="pane term">
        <div class="pane-title"><span>Terminal</span></div>
        <div ref="terminal" class="screen" role="log" aria-live="polite">
          <span v-if="!segments.length" class="info">{{ placeholder }}</span>
          <template v-for="(s, i) in segments" :key="i"><span :class="s.kind">{{ s.text }}</span></template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.demo {
  container-type: inline-size;
  --ed-bg: #1f2230;
  --ed-fg: #d7dbee;
  --term-bg: #07080c;
  --accent: #8f7cff;
  margin: 28px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  background: var(--vp-c-bg);
  box-shadow: 0 18px 50px rgba(20, 19, 31, 0.18);
  font-size: 14px;
}
.demo-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--vp-c-divider); }
.demo-head strong { font-size: 15px; }
.studio { margin-left: auto; font-weight: 600; text-decoration: none; color: var(--vp-c-brand-1); }
.pick { margin-left: 8px; font: inherit; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #6b6f86; flex: none; }
.dot.on { background: #4ade80; }
.dot.run { background: #fbbf24; }
.dot.wait { background: #60a5fa; }
.dot.err { background: #f87171; }

.demo-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #0d0e16; color: #c9cce0; }
.demo-bar code { font-size: 13.5px; color: #c9cce0; background: none; }
.spacer { flex: 1; }
button { font: inherit; cursor: pointer; border: 0; border-radius: 10px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.run { padding: 8px 18px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #8f7cff, #5236e0); }
.run.stop { background: #3a3d55; }
.ghost { padding: 7px 12px; color: #c9cce0; background: transparent; border: 1px solid #34374d; }

.demo-body { display: grid; grid-template-columns: 1fr 1fr; height: 360px; }
.pane { min-width: 0; display: flex; flex-direction: column; }
.pane-title { display: flex; justify-content: space-between; padding: 8px 16px; font: 12.5px var(--vp-font-family-mono); color: #9ea2bb; background: #14161f; border-bottom: 1px solid #23263a; }
.hint { color: #6f7390; }
.editor { background: var(--ed-bg); border-right: 1px solid #23263a; }
.editor-area { position: relative; flex: 1; display: flex; min-height: 0; font: 13.5px/1.65 var(--vp-font-family-mono); }
.gutter { width: 46px; padding: 12px 8px 12px 0; text-align: right; color: #6b7090; overflow: hidden; user-select: none; flex: none; }
.code { position: relative; flex: 1; min-width: 0; }
.hl, textarea {
  position: absolute; inset: 0; margin: 0; padding: 12px 14px;
  font: inherit; line-height: inherit; white-space: pre; tab-size: 2; letter-spacing: 0;
  overflow: auto; border: 0; outline: none; background: transparent;
}
.hl { color: #e6e9f7; pointer-events: none; overflow: hidden; }
textarea { color-scheme: dark; color: transparent; caret-color: #fff; resize: none; -webkit-text-fill-color: transparent; }
textarea::selection { background: rgba(143, 124, 255, 0.35); -webkit-text-fill-color: transparent; }
.hl :deep(.t-c) { color: #8a90ad; font-style: italic; }
.hl :deep(.t-s) { color: #a5d6a7; }
.hl :deep(.t-k) { color: #c9a6ff; }
.hl :deep(.t-n) { color: #f7c978; }
.hl :deep(.t-f) { color: #8ab4ff; }

.term { background: var(--term-bg); }
.screen { color-scheme: dark; flex: 1; overflow: auto; padding: 12px 16px; font: 13.5px/1.6 var(--vp-font-family-mono); white-space: pre-wrap; word-break: break-word; color: #d7dbee; }
.screen .info { color: #7c819e; }
.screen .err { color: #ff8f8f; }

/* Side by side only when each pane is wide enough to read code in; otherwise stack them at full width.
   (Measured on the demo itself, not the window: the docs column is narrow even on a wide screen.) */
@container (max-width: 980px) {
  .demo-body { grid-template-columns: 1fr; height: auto; }
  .editor { height: 440px; border-right: 0; border-bottom: 1px solid #23263a; }
  .term { height: 260px; }
}
@container (max-width: 520px) {
  .hint { display: none; }
}
</style>
