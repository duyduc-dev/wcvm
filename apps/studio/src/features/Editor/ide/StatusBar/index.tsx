import { useSyncExternalStore } from "react";
import { useIde } from "../controller/useIde";

export function StatusBar() {
  const { c, snap } = useIde();
  const status = useSyncExternalStore(c.editorStatus.subscribe, c.editorStatus.getSnapshot);

  return (
    <div className="flex h-6 shrink-0 items-center bg-[#007acc] px-2 text-xs text-white">
      {snap.statusMessage && <span className="min-w-0 truncate px-2">{snap.statusMessage}</span>}

      <span className="flex-1" />

      {status.cursor && (
        <span className="px-2 whitespace-nowrap">
          Ln {status.cursor.line}, Col {status.cursor.column}
          {status.cursor.selectionCount > 1
            ? ` (${status.cursor.selectionCount} selections)`
            : status.cursor.selectedChars > 0 && ` (${status.cursor.selectedChars} selected)`}
        </span>
      )}
      {status.language && <span className="px-2 whitespace-nowrap capitalize">{status.language}</span>}
    </div>
  );
}
