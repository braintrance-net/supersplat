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
    // TODO: pass file to the editor
    const url = URL.createObjectURL(file);
    window.open(`http://localhost:3000?url=${encodeURIComponent(url)}`, "_blank");
  };

  const handleTest = () => {
    window.open("http://localhost:3000", "_blank");
  };

  return (
    <div>
      {/* Hero — full-screen polaroid background */}
      <section className="relative h-screen w-full overflow-hidden">
        <Image
          src="/images/polaroids.jpg"
          alt="Scattered polaroid photographs"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-white" />
      </section>

      {/* Title section */}
      <section className="flex flex-col items-center justify-center bg-white px-6 py-32">
        <h1 className="text-6xl font-bold tracking-tight text-black sm:text-8xl">
          BrainTrance
        </h1>
        <p className="mt-6 max-w-md text-center text-lg text-neutral-500 sm:text-xl">
          Freeze the feeling.
        </p>

        <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row">
          <button
            onClick={handleUpload}
            className="flex h-12 items-center justify-center rounded-full bg-black px-8 text-base font-medium text-white transition-colors hover:bg-neutral-800"
          >
            Upload
          </button>
          <button
            onClick={handleTest}
            className="flex h-12 items-center justify-center rounded-full border border-neutral-300 px-8 text-base font-medium text-black transition-colors hover:bg-neutral-100"
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
      </section>
    </div>
  );
}
