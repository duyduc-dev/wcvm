<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useData } from "vitepress";
import type { IEmbedProject, IEmbedVm } from "@wcvm/sdk";
import { EMBED_EXAMPLES } from "./embedExamples";
import { isolated } from "./wcvm";

const props = withDefaults(defineProps<{ example?: string; height?: number; picker?: boolean }>(), {
  example: "script",
  picker: false,
  height: 640,
});

const { isDark } = useData();

type Status = "idle" | "loading" | "ready" | "unsupported" | "error";

const selected = ref(props.example);
const status = ref<Status>("idle");
const message = ref("");
const host = ref<HTMLElement | null>(null);

let vm: IEmbedVm | undefined;
let token = 0;

const stop = () => {
  token++;
  vm?.destroy();
  vm = undefined;
};

// The editor is a whole Studio in an iframe, so it only loads once the visitor asks for it.
const launch = async () => {
  if (!isolated()) {
    status.value = "unsupported";
    return;
  }
  const example = EMBED_EXAMPLES.find((e) => e.id === selected.value) ?? EMBED_EXAMPLES[0];
  const mine = ++token;
  vm?.destroy();
  vm = undefined;
  status.value = "loading";
  message.value = "";
  try {
    // Imported on demand: the SDK touches `document`, so it must never run during the build's SSR.
    const { embed } = await import("@wcvm/sdk");
    const project: IEmbedProject = {
      title: example.title,
      files: example.files,
      openFile: example.openFile,
      startCommand: example.startCommand,
    };
    const created = await embed(host.value as HTMLElement, project, {
      view: example.view,
      panes: { terminal: true },
      theme: isDark.value ? "dark" : "light",
      height: props.height,
    });
    if (mine !== token) return created.destroy();
    vm = created;
    status.value = "ready";
  } catch (error) {
    if (mine !== token) return;
    status.value = "error";
    message.value = error instanceof Error ? error.message : String(error);
  }
};

const pick = (id: string) => {
  selected.value = id;
  if (status.value !== "idle") void launch();
};

onBeforeUnmount(stop);
</script>

<template>
  <div class="embed-demo">
    <div class="embed-head">
      <strong>Live Node terminal</strong>
      <span class="embed-hint">Studio, embedded with <code>@wcvm/sdk</code></span>
      <select v-if="picker" class="embed-pick" :value="selected" aria-label="Example" @change="pick(($event.target as HTMLSelectElement).value)">
        <option v-for="e in EMBED_EXAMPLES" :key="e.id" :value="e.id">{{ e.title }}</option>
      </select>
    </div>

    <div class="embed-body" :style="{ height: `${height}px` }">
      <div ref="host" class="embed-host" />
      <div v-if="status !== 'ready'" class="embed-cover">
        <p v-if="status === 'unsupported'">
          This page is not cross-origin isolated, so the editor cannot start. See
          <a href="/guide/headers">the required headers</a>.
        </p>
        <p v-else-if="status === 'error'" class="embed-error">{{ message }}</p>
        <p v-else-if="status === 'loading'">Starting the editor... the first load installs nothing and takes a few seconds.</p>
        <button v-if="status === 'idle' || status === 'error'" class="embed-launch" type="button" @click="launch">
          {{ status === "error" ? "Try again" : "Launch the editor" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.embed-demo { margin: 24px 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg); }
.embed-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--vp-c-divider); }
.embed-hint { color: var(--vp-c-text-2); font-size: 13px; }
.embed-pick { margin-left: auto; font: inherit; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.embed-body { position: relative; }
.embed-host { position: absolute; inset: 0; }
.embed-cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); }
.embed-cover p { margin: 0; max-width: 460px; }
.embed-error { color: var(--vp-c-danger-1); }
.embed-launch { padding: 8px 18px; border-radius: 999px; border: 0; font: inherit; font-weight: 600; color: #fff; background: var(--vp-c-brand-1); cursor: pointer; }
.embed-launch:hover { background: var(--vp-c-brand-2); }
</style>
