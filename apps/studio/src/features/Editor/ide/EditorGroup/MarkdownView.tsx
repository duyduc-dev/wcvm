import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useState } from "react";
import { useIde } from "../controller/useIde";

export function MarkdownView({ path }: { path: string }) {
  const { c } = useIde();
  const [source, setSource] = useState(() => c.textOf(path));

  useEffect(() => {
    // The initial value comes from useState above (this view is keyed by path).
    return c.onContentChange(() => setSource(c.textOf(path)));
  }, [c, path]);

  const html = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }));

  return (
    <div className="absolute inset-0 overflow-auto bg-white p-6 dark:bg-[#1e1e1e]">
      <article
        className="mx-auto max-w-3xl text-sm leading-relaxed text-foreground [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:pb-1 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:max-w-full [&_ol]:ml-6 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:ml-6 [&_ul]:list-disc"
        // Sanitized above.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
