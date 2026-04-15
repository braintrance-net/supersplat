"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef } from "react";

function EditorFrame() {
  const searchParams = useSearchParams();
  const load = searchParams.get("load");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const editorUrl = load
    ? `http://localhost:3000?load=${encodeURIComponent(load)}`
    : "http://localhost:3000";

  // Send pending file to the editor iframe once it loads
  const handleIframeLoad = useCallback(() => {
    const pendingFile = sessionStorage.getItem("pendingFile");
    if (!pendingFile) return;

    sessionStorage.removeItem("pendingFile");

    // Reconstruct the file from the stored data
    const { name, type, data } = JSON.parse(pendingFile);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type });

    // Give the editor a moment to initialize
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
