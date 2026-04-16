"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useRef } from "react";

declare global {
  interface Window {
    __pendingFile?: File;
    __pendingAsset?: {
      filename: string;
      data: ArrayBuffer;
    };
  }
}

function EditorFrame() {
  const searchParams = useSearchParams();
  const load = searchParams.get("load");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const hasPendingFile = typeof window !== "undefined" && !!window.__pendingFile;
  const hasPendingAsset = typeof window !== "undefined" && !!window.__pendingAsset;

  let editorUrl = "http://localhost:3000";
  if (load) {
    editorUrl += `?load=${encodeURIComponent(load)}`;
  } else if (hasPendingFile || hasPendingAsset) {
    editorUrl += "?skipDefault";
  }

  const handleIframeLoad = useCallback(async () => {
    const file = window.__pendingFile;
    const asset = window.__pendingAsset;
    if (!file && !asset) return;

    let filename: string;
    let data: ArrayBuffer;

    if (file) {
      delete window.__pendingFile;
      filename = file.name;
      data = await file.arrayBuffer();
    } else {
      delete window.__pendingAsset;
      filename = asset!.filename;
      data = asset!.data;
    }

    // Give the editor time to initialize
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "supersplat:load-file", filename, data },
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
