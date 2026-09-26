import { basename } from "../controller/fs.service";
import { useIde } from "../controller/useIde";

export function ImageView({ path }: { path: string }) {
  const { c } = useIde();
  const url = c.imageUrlFor(path);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-white p-6 dark:bg-[#1e1e1e]">
      {url ? (
        <img src={url} alt={basename(path)} className="max-h-[calc(100vh-12rem)] max-w-full object-contain" />
      ) : (
        <div className="p-8 text-sm text-muted-foreground">Loading image…</div>
      )}
      <div className="text-xs text-muted-foreground">{basename(path)}</div>
    </div>
  );
}
