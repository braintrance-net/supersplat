"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function EditorFrame() {
  const searchParams = useSearchParams();
  const load = searchParams.get("load");

  const editorUrl = load
    ? `http://localhost:3000?load=${encodeURIComponent(load)}`
    : "http://localhost:3000";

  return (
    <iframe
      src={editorUrl}
      className="h-screen w-screen border-0"
      allow="clipboard-read; clipboard-write"
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
