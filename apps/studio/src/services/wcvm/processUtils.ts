import type { IProcess } from "wcvm";

/** Drains a spawned process's stdout+stderr into one combined string — used to surface an
 * install/scaffold failure's real output in the UI. */
export const collectText = async (process: IProcess): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  await Promise.all(
    [process.stdout, process.stderr].map(async (stream) => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    }),
  );
  return text;
};
