import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

/** The two guided tours. Each runs once, automatically, for a new visitor and can be replayed from
 *  the "Take a tour" button. "Seen" is remembered in localStorage; where that is unavailable (a private
 *  window, blocked site data) the tour simply offers itself again, which is harmless. */
export type TourKind = "home" | "editor" | "create-react";
/** The tours that offer themselves to a first-time visitor; "create-react" only runs when asked. */
type AutoTourKind = Exclude<TourKind, "create-react">;

let active: ReturnType<typeof driver> | null = null;

const STORAGE_KEY = (kind: AutoTourKind) => `wcvm-studio-tour-${kind}`;

const readSeen = (kind: AutoTourKind): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY(kind)) === "done";
  } catch {
    return false;
  }
};

const markSeen = (kind: AutoTourKind): void => {
  try {
    localStorage.setItem(STORAGE_KEY(kind), "done");
  } catch {
    /* nothing to remember it in */
  }
};

/** "Ctrl" or "⌘", for the shortcuts quoted in the steps. */
const mod = (): string => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+");

const homeSteps = (): DriveStep[] => [
  {
    popover: {
      title: "Welcome to WCVM Studio",
      description:
        "Node.js, running entirely in this browser tab: real processes, <code>npm install</code> and dev servers, with no backend. This one-minute tour shows you where things are.",
    },
  },
  {
    element: '[data-tour="templates"]',
    popover: {
      title: "Start a project",
      description:
        "Pick <b>Start from blank</b>, or <b>Start from template</b> for React, Vue, Svelte, Next.js, Express, NestJS and more. Dependencies install by themselves once the editor opens. Not sure where to begin? Use <b>Guide me</b> on the right: it walks you through creating a React app.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="recent"]',
    popover: {
      title: "Your recent projects",
      description:
        "Projects are saved in this browser, so they are still here next time. <code>node_modules</code> is not saved: it is reinstalled when you open a project.",
      side: "top",
      align: "start",
    },
  },
  {
    element: '[data-tour="site-links"]',
    popover: {
      title: "More about wcvm",
      description:
        "The website, the docs, GitHub and npm. They open in a new tab, so your work here stays where it is.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: '[data-tour="tour-button"]',
    popover: {
      title: "Take the tour again",
      description: "Use this button whenever you want to see this guide again.",
      side: "bottom",
      align: "end",
    },
  },
];

const editorSteps = (): DriveStep[] => [
  {
    popover: {
      title: "Your project, in the browser",
      description:
        "This is the editor. Everything here runs in this tab: the files, the terminal and the preview.",
    },
  },
  {
    element: '[data-tour="explorer"]',
    popover: {
      title: "Explorer",
      description:
        "Your project's files. Use the icons above to add a file or folder, and the context menu to rename or delete. Changes made in the terminal show up here by themselves.",
      side: "right",
      align: "start",
    },
  },
  {
    element: '[data-tour="editor"]',
    popover: {
      title: "Editor",
      description: `A full code editor with type checking and completions from your installed packages. <b>${mod()}S</b> saves, <b>${mod()}P</b> opens a file by name, <b>${mod()}⇧P</b> opens the command palette, and <b>⇧⌥F</b> formats the file.`,
      side: "bottom",
      align: "center",
    },
  },
  {
    element: '[data-tour="terminal"]',
    popover: {
      title: "Terminal",
      description:
        "A shell with <code>node</code> and <code>npm</code>. A new project installs its dependencies here when it opens; watch the bar for progress. Then run <code>npm run dev</code>. Press <b>+</b> for another terminal.",
      side: "top",
      align: "start",
    },
  },
  {
    element: '[data-tour="preview"]',
    popover: {
      title: "Preview",
      description:
        "When a dev server starts listening, it appears here by itself, with hot reload. Open it in its own tab, or inspect it with the devtools below.",
      side: "left",
      align: "start",
    },
  },
  {
    element: '[data-tour="layout-toggles"]',
    popover: {
      title: "Show and hide panels",
      description: `Toggle the explorer (<b>${mod()}B</b>), the terminal (<b>${mod()}J</b>) and the preview in the top bar.`,
      side: "bottom",
      align: "end",
    },
  },
  {
    element: '[data-tour="tour-button"]',
    popover: {
      title: "Need this again?",
      description: "Click this button to replay the tour. Happy building!",
      side: "bottom",
      align: "end",
    },
  },
];

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Resolves with the element once it exists (a dialog opening takes a moment), or null. */
const waitFor = async (selector: string, timeoutMs = 2500): Promise<HTMLElement | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.getClientRects().length > 0) return el;
    await sleep(50);
  }
  return null;
};

/** Makes sure React + TypeScript is the selected framework, whatever the dialog was left on. */
const selectReactTs = async (): Promise<void> => {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Frontend");
  if (tab && tab.getAttribute("aria-selected") !== "true") {
    tab.click();
    await sleep(150);
  }
  const option = document.querySelector<HTMLElement>('[data-framework="react-ts"]');
  if (option && option.getAttribute("aria-pressed") !== "true") option.click();
};

/** Shows `hint` under a step's text, replacing a previous one. */
const showHint = (hint: string): void => {
  const description = document.querySelector(".driver-popover-description");
  if (!description) return;
  description.querySelector(".wcvm-tour-hint")?.remove();
  const el = document.createElement("p");
  el.className = "wcvm-tour-hint";
  el.textContent = hint;
  description.appendChild(el);
};

/** Walks through the "Start from template" dialog for a React + TypeScript project. The tour opens
 *  the dialog and selects React, and the visitor types the name and presses Create themselves. */
const createReactSteps = (): DriveStep[] => [
  {
    element: '[data-template-card="start-from-template"]',
    popover: {
      title: "1. Start from a template",
      description: "Templates are real, working projects. Click <b>Next</b> and the template window opens.",
      side: "bottom",
      align: "start",
      onNextClick: async (_element, _step, { driver: tour }) => {
        document.querySelector<HTMLElement>('[data-template-card="start-from-template"]')?.click();
        if (await waitFor('[data-tour="template-frameworks"]')) tour.moveNext();
      },
    },
  },
  {
    element: '[data-tour="template-frameworks"]',
    onHighlightStarted: () => void selectReactTs(),
    popover: {
      title: "2. Pick React + TypeScript",
      description:
        "It is already selected (look for the highlighted card). The tabs hold more: <b>Backend</b> for Express and NestJS, <b>Fullstack</b> for Next.js, SvelteKit and Astro.",
      side: "left",
      align: "start",
    },
  },
  {
    element: '[data-tour="template-name"]',
    onHighlighted: () => document.querySelector<HTMLInputElement>("#template-project-name")?.focus(),
    popover: {
      title: "3. Name your project",
      description: "Type a name, for example <code>my-react-app</code>. Spaces become dashes.",
      side: "left",
      align: "start",
      onNextClick: (_element, _step, { driver: tour }) => {
        const input = document.querySelector<HTMLInputElement>("#template-project-name");
        if (!input?.value.trim()) {
          input?.focus();
          showHint("Type a name first, then press Next.");
          return;
        }
        tour.moveNext();
      },
    },
  },
  {
    element: '[data-tour="template-directory"]',
    popover: {
      title: "4. Where it is saved",
      description:
        "The default folder is fine. It is in this browser's private storage, not on your computer, and it is kept for next time.",
      side: "left",
      align: "start",
    },
  },
  {
    element: '[data-tour="template-create"]',
    popover: {
      title: "5. Create it",
      description:
        "Press <b>Create</b>. Studio writes the files and opens the editor, where the terminal installs the dependencies by itself. When it finishes, run <code>npm run dev</code> and the preview appears.",
      side: "top",
      align: "end",
      doneBtnText: "Got it",
    },
  },
];

export const isTourActive = (): boolean => active !== null;

const stepsFor = (kind: TourKind): DriveStep[] => {
  // This tour's steps point into a dialog that only exists once an earlier step opens it, so they
  // are not checked up front like the others.
  if (kind === "create-react") return createReactSteps();
  const steps = kind === "home" ? homeSteps() : editorSteps();
  // A step whose element is not on screen (no recent projects yet, a hidden panel, a narrow window)
  // is dropped rather than shown pointing at nothing. Steps without an element are centered cards.
  return steps.filter((step) => {
    if (typeof step.element !== "string") return true;
    const el = document.querySelector<HTMLElement>(step.element);
    return !!el && el.getClientRects().length > 0;
  });
};

/** Starts a tour now. Safe to call twice: a running tour is restarted, not stacked. */
export const startTour = (kind: TourKind): void => {
  active?.destroy();
  const steps = stepsFor(kind);
  if (steps.length === 0) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tour = driver({
    steps,
    showProgress: true,
    progressText: "{{current}} of {{total}}",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    allowClose: true,
    animate: !reduceMotion,
    smoothScroll: !reduceMotion,
    stagePadding: 6,
    stageRadius: 6,
    popoverClass: "wcvm-tour",
    // Closing it at any point counts as seen: a tour must never come back uninvited.
    onDestroyed: () => {
      if (kind !== "create-react") markSeen(kind);
      if (active === tour) active = null;
    },
  });
  active = tour;
  tour.drive();
};

/** Starts the tour for a first-time visitor, once the page has settled. Returns a cleanup that
 *  cancels a start still waiting. */
export const startTourOnFirstVisit = (kind: AutoTourKind, delayMs = 900): (() => void) => {
  if (readSeen(kind)) return () => {};
  const timer = window.setTimeout(() => startTour(kind), delayMs);
  return () => {
    window.clearTimeout(timer);
  };
};
