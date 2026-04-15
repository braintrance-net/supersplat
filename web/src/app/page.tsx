import Image from "next/image";

export default function Home() {
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
        {/* Subtle dark overlay so the text section below feels like a reveal */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-white" />
      </section>

      {/* Title section */}
      <section className="flex flex-col items-center justify-center bg-white px-6 py-32">
        <h1 className="text-6xl font-bold tracking-tight text-black sm:text-8xl">
          BrainTrance
        </h1>
        <p className="mt-6 max-w-md text-center text-lg text-neutral-500 sm:text-xl">
          Life moves fast. Stop and enjoy it.
        </p>
      </section>
    </div>
  );
}
