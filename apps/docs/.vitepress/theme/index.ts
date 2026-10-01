import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import LiveDemo from "./LiveDemo.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("LiveDemo", LiveDemo);
  },
} satisfies Theme;
