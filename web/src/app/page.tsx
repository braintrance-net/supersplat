"use client";

import Image from "next/image";
import { useRef } from "react";

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    window.open(`http://localhost:3000?url=${encodeURIComponent(url)}`, "_blank");
  };

  const handleTest = () => {
    window.open("http://localhost:3000", "_blank");
  };

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Background image */}
      <Image
        src="/images/polaroids.jpg"
        alt="Scattered polaroid photographs"
        fill
        className="object-cover"
        priority
      />

      {/* Dark overlay for legibility */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Content centered on top */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6">
        <h1 className="text-7xl font-bold tracking-wide text-white sm:text-9xl">
          BrainTrance
        </h1>
        <p className="mt-3 text-xl font-light tracking-widest uppercase text-white/60 sm:text-2xl">
          Freeze the feeling
        </p>

        <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row">
          {/* Upload — primary liquid glass button */}
          <button
            onClick={handleUpload}
            className="group relative flex h-14 items-center justify-center rounded-xl px-10 text-lg font-semibold tracking-wide text-white backdrop-blur-xl transition-all duration-300 hover:scale-105"
            style={{
              background: "rgba(252, 252, 255, 0.15)",
              border: "1px solid rgba(255, 255, 255, 0.25)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(255,255,255,0.1), 0 8px 32px rgba(0,0,0,0.2)",
            }}
          >
            <span className="relative z-10">Upload</span>
            <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-white/20 to-transparent opacity-60" />
          </button>

          {/* Try Demo — secondary liquid glass button */}
          <button
            onClick={handleTest}
            className="group relative flex h-14 items-center justify-center rounded-xl px-10 text-lg font-semibold tracking-wide text-white/70 backdrop-blur-xl transition-all duration-300 hover:scale-105 hover:text-white"
            style={{
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.15), 0 4px 24px rgba(0,0,0,0.15)",
            }}
          >
            <span className="relative z-10">Try Demo</span>
            <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-white/10 to-transparent opacity-40" />
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".ply,.splat,.spz"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  );
}
