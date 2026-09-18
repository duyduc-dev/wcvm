import { boot } from "wcvm";

const app = boot();

app.diagnostics.onEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}`, event.payload);
});

app.spawn("echo", ["Hello, World!"]);
