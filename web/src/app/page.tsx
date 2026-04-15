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

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Content */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6">
        <h1 className="text-7xl font-bold tracking-wide text-white sm:text-9xl">
          BrainTrance
        </h1>
        <p className="mt-3 text-xl font-light tracking-widest uppercase text-white/60 sm:text-2xl">
          Freeze the feeling
        </p>

        <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row">
          {/* Upload — solid white button */}
          <button
            onClick={handleUpload}
            className="flex h-14 items-center justify-center rounded-xl bg-white px-10 text-lg font-semibold tracking-wide text-black transition-all duration-200 hover:bg-neutral-200 hover:scale-105"
          >
            Upload
          </button>

          {/* Try Demo — ghost outline button */}
          <button
            onClick={handleTest}
            className="flex h-14 items-center justify-center rounded-xl border border-white/30 px-10 text-lg font-semibold tracking-wide text-white/70 transition-all duration-200 hover:border-white/60 hover:text-white hover:scale-105"
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
