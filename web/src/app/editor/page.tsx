"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useRef } from "react";

function EditorFrame() {
  const searchParams = useSearchParams();
  const load = searchParams.get("load");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const editorUrl = load
    ? `http://localhost:3000?load=${encodeURIComponent(load)}`
    : "http://localhost:3000";

  const handleIframeLoad = useCallback(() => {
    const file = (window as any).__pendingFile as File | undefined;
    if (!file) return;
    delete (window as any).__pendingFile;

    // Give the editor time to initialize
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "supersplat:load-file", file },
        "*"
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
