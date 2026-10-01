// The page's only script: the copy button, scroll reveals, the cursor glow on cards, and the terminal that
// "runs" a Vite dev server. None of it is needed to read the page; with prefers-reduced-motion the terminal
// is drawn finished instead of typed.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── copy button ───────────────────────────────────────────────────────────────────────────────────
const copy = document.getElementById("copy");
const command = document.getElementById("install-cmd");
copy?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    copy.textContent = "Copied";
  } catch {
    // Clipboard access can be blocked (insecure context, permissions): select the text instead.
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    copy.textContent = "Press Ctrl+C";
  }
  setTimeout(() => (copy.textContent = "Copy"), 1800);
});

// ── scroll reveal ─────────────────────────────────────────────────────────────────────────────────
const revealables = document.querySelectorAll(".reveal");
if (reduced || !("IntersectionObserver" in window)) {
  revealables.forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
  );
  revealables.forEach((el) => io.observe(el));
}

// ── a glow that follows the pointer across a card ─────────────────────────────────────────────────
document.querySelectorAll(".card").forEach((card) => {
  card.addEventListener("pointermove", (event) => {
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  });
});

// ── the terminal ──────────────────────────────────────────────────────────────────────────────────
const term = document.getElementById("term");
const browser = document.getElementById("browser");
const counter = document.getElementById("count");

// Each step: a typed command, or an output line printed after a pause. `c` picks a colour class.
const SCRIPT = [
  { cmd: "npm install", pause: 350 },
  { out: "added 214 packages in 3.1s", c: "dim", pause: 650 },
  { cmd: "npm run dev", pause: 450 },
  { out: "", pause: 150 },
  { out: "  <b>VITE</b> v7.3  ready in 412 ms", c: "ok", pause: 350 },
  { out: "  &#10140;  Local:   <u>/__wcvm_preview__/5173/</u>", c: "url", pause: 450 },
  { out: "  &#10003; hot reload connected", c: "ok", pause: 0, show: true },
];

const line = (html, cls = "") => {
  const el = document.createElement("div");
  el.className = `ln ${cls}`.trim();
  el.innerHTML = html;
  term.appendChild(el);
  term.scrollTop = term.scrollHeight;
  return el;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let count = 0;
let counting;

const showBrowser = () => {
  browser.classList.add("on");
  clearInterval(counting);
  count = 0;
  counter.textContent = "0";
  if (!reduced) {
    counting = setInterval(() => {
      count += 1;
      counter.textContent = String(count);
      counter.parentElement.classList.add("tap");
      setTimeout(() => counter.parentElement.classList.remove("tap"), 160);
    }, 1100);
  }
};

const play = async () => {
  for (;;) {
    term.innerHTML = "";
    browser.classList.remove("on");
    clearInterval(counting);
    for (const step of SCRIPT) {
      if ("cmd" in step) {
        const el = line('<span class="pr">$</span> <span class="cm"></span><i class="caret"></i>');
        const target = el.querySelector(".cm");
        for (const ch of step.cmd) {
          target.textContent += ch;
          await sleep(55 + Math.random() * 55);
        }
        el.querySelector(".caret").remove();
      } else {
        line(step.out, step.c);
      }
      if (step.show) showBrowser();
      await sleep(step.pause);
    }
    await sleep(9000);
  }
};

if (reduced) {
  for (const step of SCRIPT) line("cmd" in step ? `<span class="pr">$</span> ${step.cmd}` : step.out, step.c);
  showBrowser();
} else {
  void play();
}

// ── scroll-linked effects: progress bar, header, parallax, and the Studio mock tilting into view ──
const progressBar = document.getElementById("progress");
const header = document.getElementById("top");
const mock = document.getElementById("mock");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
let ticking = false;

const onScroll = () => {
  ticking = false;
  const y = scrollY;
  const max = document.documentElement.scrollHeight - innerHeight;
  if (progressBar) progressBar.style.transform = `scaleX(${max > 0 ? clamp(y / max, 0, 1) : 0})`;
  header?.classList.toggle("scrolled", y > 20);
  if (!reduced) document.documentElement.style.setProperty("--sy", String(Math.min(y, 1400)));
  if (mock) {
    const box = mock.getBoundingClientRect();
    const p = reduced ? 1 : clamp((innerHeight - box.top) / (innerHeight * 0.78), 0, 1);
    mock.style.setProperty("--p", p.toFixed(3));
    if (p > 0.4) mock.classList.add("in");
  }
};
addEventListener("scroll", () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(onScroll);
  }
}, { passive: true });
addEventListener("resize", onScroll);
onScroll();

// ── the sticky story: the visual on the left follows the step in the middle of the screen ─────────
const visual = document.getElementById("story-visual");
const steps = [...document.querySelectorAll(".step")];
if (visual && steps.length) {
  steps[0].classList.add("on");
  const stepIo = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number(entry.target.dataset.step);
        visual.dataset.step = String(index);
        steps.forEach((el, i) => el.classList.toggle("on", i === index));
      }
    },
    { rootMargin: "-42% 0px -42% 0px" },
  );
  steps.forEach((el) => stepIo.observe(el));
}

// ── numbers that count up when they scroll into view ───────────────────────────────────────────────
const format = (el, value) => {
  el.textContent = `${el.dataset.prefix ?? ""}${Math.round(value).toLocaleString("en-US")}${el.dataset.suffix ?? ""}`;
};
const countUp = (el) => {
  const target = Number(el.dataset.count);
  if (reduced || target === 0) return format(el, target);
  const started = performance.now();
  const step = (now) => {
    const t = clamp((now - started) / 1500, 0, 1);
    format(el, target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
const countIo = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      countIo.unobserve(entry.target);
      countUp(entry.target);
    }
  },
  { threshold: 0.6 },
);
document.querySelectorAll(".num[data-count]").forEach((el) => {
  if (reduced) format(el, Number(el.dataset.count));
  else countIo.observe(el);
});

// ── the Studio mock: the button in its preview gets clicked once the code has typed in ────────────
const mockCount = document.getElementById("mock-n");
if (mock && mockCount) {
  let clicks = 0;
  const startClicking = () => {
    const button = mockCount.parentElement;
    setInterval(() => {
      clicks += 1;
      mockCount.textContent = String(clicks);
      button.classList.add("tap");
      setTimeout(() => button.classList.remove("tap"), 150);
    }, 1300);
  };
  if (reduced) mockCount.textContent = "3";
  else {
    const wait = setInterval(() => {
      if (!mock.classList.contains("in")) return;
      clearInterval(wait);
      setTimeout(startClicking, 2600);
    }, 300);
  }
}

// ── tabs in the code box ───────────────────────────────────────────────────────────────────────────
const tabButtons = [...document.querySelectorAll(".tabs button[data-tab]")];
const panes = [...document.querySelectorAll(".pane")];
tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    tabButtons.forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    panes.forEach((pane) => pane.classList.toggle("on", pane.dataset.tab === button.dataset.tab));
  });
});
const copyCode = document.getElementById("copy-code");
copyCode?.addEventListener("click", async () => {
  const text = document.querySelector(".pane.on")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    copyCode.textContent = "Copied";
  } catch {
    copyCode.textContent = "Select and copy";
  }
  setTimeout(() => (copyCode.textContent = "Copy"), 1800);
});

// ── highlight the nav link of the section being read ───────────────────────────────────────────────
const spyLinks = [...document.querySelectorAll("[data-spy]")];
const spyIo = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      // Whichever section is under the middle of the screen: a link lights up only if that section has one.
      if (entry.isIntersecting) spyLinks.forEach((a) => a.classList.toggle("active", a.dataset.spy === entry.target.id));
    }
  },
  { rootMargin: "-45% 0px -50% 0px" },
);
document.querySelectorAll("main > section[id]").forEach((section) => spyIo.observe(section));
