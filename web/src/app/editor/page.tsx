"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useRef } from "react";

function EditorFrame() {
  const searchParams = useSearchParams();
  const load = searchParams.get("load");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const hasPendingFile = typeof window !== "undefined" && !!(window as any).__pendingFile;

  let editorUrl = "http://localhost:3000";
  if (load) {
    editorUrl += `?load=${encodeURIComponent(load)}`;
  } else if (hasPendingFile) {
    editorUrl += "?skipDefault";
  }

  const handleIframeLoad = useCallback(async () => {
    const file = (window as any).__pendingFile as File | undefined;
    if (!file) return;
    delete (window as any).__pendingFile;

    const data = await file.arrayBuffer();

    // Give the editor time to initialize
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "supersplat:load-file", filename: file.name, data },
        "*",
        [data] // transfer the ArrayBuffer for performance
      );
    }, 2000);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src={editorUrl}
      className="h-screen w-screen border-0"
      allow="clipboard-read; clipboard-write"
      onLoad={handleIframeLoad}
    />
  );
}

export default function EditorPage() {
  return (
    <Suspense>
      <EditorFrame />
    </Suspense>
  );
}
