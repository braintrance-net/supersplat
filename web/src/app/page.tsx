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
      <div className="absolute inset-0 bg-black/40" />

      {/* Content centered on top */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6">
        <h1 className="text-6xl font-bold tracking-tight text-white sm:text-8xl">
          BrainTrance
        </h1>
        <p className="mt-4 text-lg text-white/70 sm:text-xl">
          Freeze the feeling.
        </p>

        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <button
            onClick={handleUpload}
            className="flex h-12 items-center justify-center rounded-full bg-white px-8 text-base font-medium text-black transition-colors hover:bg-neutral-200"
          >
            Upload
          </button>
          <button
            onClick={handleTest}
            className="flex h-12 items-center justify-center rounded-full border border-white/30 px-8 text-base font-medium text-white transition-colors hover:bg-white/10"
          >
            Try Demo
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
