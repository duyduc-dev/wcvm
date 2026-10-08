import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import EmbedPlayground from "./EmbedPlayground.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("EmbedPlayground", EmbedPlayground);
  },
} satisfies Theme;
