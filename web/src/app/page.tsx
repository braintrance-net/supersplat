"use client";

import Image from "next/image";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Caveat,
  Gloria_Hallelujah,
  Indie_Flower,
  Kalam,
  Patrick_Hand,
  Shadows_Into_Light,
  Sue_Ellen_Francisco,
} from "next/font/google";

const caveat = Caveat({ subsets: ["latin"], weight: ["500", "700"] });
const gloria = Gloria_Hallelujah({ subsets: ["latin"], weight: "400" });
const indie = Indie_Flower({ subsets: ["latin"], weight: "400" });
const kalam = Kalam({ subsets: ["latin"], weight: ["300", "400", "700"] });
const patrick = Patrick_Hand({ subsets: ["latin"], weight: "400" });
const shadows = Shadows_Into_Light({ subsets: ["latin"], weight: "400" });
const sue = Sue_Ellen_Francisco({ subsets: ["latin"], weight: "400" });

type SceneCard = {
  id: string;
  title: string;
  transform: string;
  widthClassName: string;
  imageSrc: string;
  imageAlt: string;
  imagePosition?: string;
  titleClassName: string;
};

type ActiveScene = {
  id: string;
  rect: DOMRect;
};

const sceneCards: SceneCard[] = [
  {
    id: "gallery",
    title: "Opening Night",
    transform: "translate(4vw, 7vh) rotate(-10deg)",
    widthClassName: "w-[224px] sm:w-[246px] lg:w-[268px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "50% 56%",
    titleClassName: `${caveat.className} rotate-[-2deg] text-[1.72rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "vegas",
    title: "Vegas Blur",
    transform: "translate(30vw, 13vh) rotate(8deg)",
    widthClassName: "w-[214px] sm:w-[236px] lg:w-[252px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "56% 48%",
    titleClassName: `${patrick.className} rotate-[1deg] text-[1.36rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "boat",
    title: "Boat Sunset",
    transform: "translate(58vw, 6vh) rotate(12deg)",
    widthClassName: "w-[232px] sm:w-[258px] lg:w-[280px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${shadows.className} rotate-[-1deg] text-[1.52rem] font-normal tracking-[0.015em]`,
  },
  {
    id: "gallery-echo",
    title: "After Hours",
    transform: "translate(12vw, 48vh) rotate(9deg)",
    widthClassName: "w-[220px] sm:w-[244px] lg:w-[262px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "16% 55%",
    titleClassName: `${gloria.className} rotate-[2deg] text-[1.28rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "vegas-echo",
    title: "Neon Hour",
    transform: "translate(43vw, 42vh) rotate(-7deg)",
    widthClassName: "w-[216px] sm:w-[238px] lg:w-[256px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "60% 60%",
    titleClassName: `${kalam.className} rotate-[-3deg] text-[1.48rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "boat-echo",
    title: "Golden Water",
    transform: "translate(72vw, 49vh) rotate(-13deg)",
    widthClassName: "w-[228px] sm:w-[250px] lg:w-[270px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${indie.className} rotate-[2deg] text-[1.42rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "quiet-corner",
    title: "Keep This",
    transform: "translate(63vw, 31vh) rotate(-2deg)",
    widthClassName: "w-[198px] sm:w-[220px] lg:w-[236px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "78% 44%",
    titleClassName: `${sue.className} rotate-[-1deg] text-[1.9rem] font-normal tracking-[0.005em]`,
  },
];

const filmGrain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.22'/%3E%3C/svg%3E\")";

const paperTexture =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E\")";

function Polaroid({
  scene,
  dimmed,
  hidden,
  onSelect,
}: {
  scene: SceneCard;
  dimmed: boolean;
  hidden: boolean;
  onSelect: (id: string, rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pointer, setPointer] = useState({ x: 0.5, y: 0.5 });

  const rotateX = (pointer.y - 0.5) * -10;
  const rotateY = (pointer.x - 0.5) * 12;

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open ${scene.title}`}
      className={[
        "absolute cursor-pointer select-none text-left outline-none transition-[opacity,filter,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
        scene.widthClassName,
        hidden ? "pointer-events-none opacity-0 scale-90" : dimmed ? "opacity-10 blur-[1px]" : "opacity-100",
      ].join(" ")}
      style={{ transform: `${scene.transform} ${hovered ? "translateY(-12px)" : ""}` }}
      onPointerEnter={() => setHovered(true)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointer({
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        });
      }}
      onPointerLeave={() => {
        setHovered(false);
        setPointer({ x: 0.5, y: 0.5 });
      }}
      onClick={() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) onSelect(scene.id, rect);
      }}
    >
      <div
        className="rounded-[10px] bg-[#f7f0e6] p-3 pb-6 shadow-[0_28px_80px_rgba(0,0,0,0.42),0_8px_18px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out"
        style={{
          transform: hovered
            ? `perspective(1100px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.035)`
            : "perspective(1100px) rotateX(0deg) rotateY(0deg) scale(1)",
        }}
      >
        <div
          className="relative aspect-[4/4.8] overflow-hidden rounded-[4px] border border-black/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
        >
          <Image
            src={scene.imageSrc}
            alt={scene.imageAlt}
            fill
            sizes="(max-width: 640px) 220px, (max-width: 1024px) 260px, 280px"
            className="object-cover sepia-[0.06] saturate-[0.94]"
            style={{ objectPosition: scene.imagePosition ?? "center center" }}
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.18),transparent_24%,transparent_72%,rgba(0,0,0,0.18))]" />
          <div
            className="absolute inset-[-12%] opacity-55 mix-blend-screen transition-transform duration-300 ease-out"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.56), transparent 38%)",
              transform: hovered
                ? `translate(${(pointer.x - 0.5) * 24}px, ${(pointer.y - 0.5) * 24}px)`
                : "translate(0px, 0px)",
            }}
          />
          <div
            className="absolute inset-0 opacity-35 mix-blend-multiply"
            style={{ backgroundImage: filmGrain }}
          />
          <div className="absolute bottom-0 left-0 right-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(7,7,7,0.38))]" />
        </div>
        <div className="px-2 pt-3 text-center">
          <div
            className={`${scene.titleClassName} text-center leading-none text-stone-800`}
          >
            {scene.title}
          </div>
        </div>
      </div>
    </button>
  );
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [activeScene, setActiveScene] = useState<ActiveScene | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const activeSceneData = useMemo(
    () => sceneCards.find((scene) => scene.id === activeScene?.id) ?? null,
    [activeScene?.id],
  );

  const openScene = (id: string, rect: DOMRect) => {
    setZoomed(false);
    setActiveScene({ id, rect });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setZoomed(true);
      });
    });
  };

  const closeScene = () => {
    setZoomed(false);
    window.setTimeout(() => {
      setActiveScene(null);
    }, 260);
  };

  const handleUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    (window as Window & { __pendingFile?: File }).__pendingFile = file;
    router.push("/editor");
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#120f11] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(96,73,61,0.95)_0%,rgba(27,21,24,0.88)_30%,#120f11_68%)]" />
      <div className="absolute inset-0 opacity-55 bg-[linear-gradient(115deg,rgba(241,226,196,0.08),transparent_26%,transparent_72%,rgba(255,255,255,0.05)),repeating-linear-gradient(90deg,rgba(255,255,255,0.03)_0,rgba(255,255,255,0.03)_1px,transparent_1px,transparent_120px),repeating-linear-gradient(0deg,rgba(255,255,255,0.025)_0,rgba(255,255,255,0.025)_1px,transparent_1px,transparent_110px)]" />
      <div
        className="absolute inset-0 opacity-20 mix-blend-soft-light"
        style={{ backgroundImage: paperTexture }}
      />

      <section className="relative z-10 min-h-screen px-6 py-8 sm:px-10 sm:py-10">
        <div className="pointer-events-none max-w-xl">
          <Image
            src="/images/logo.svg"
            alt="BrainTrance logo"
            width={220}
            height={56}
            className="h-14 w-auto opacity-90"
            style={{ filter: "brightness(0) invert(1)" }}
          />
          <h1
            className="mt-6 max-w-lg text-5xl font-bold leading-[0.92] tracking-[0.04em] text-white sm:text-7xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            BrainTrance
          </h1>
          <p className="mt-3 text-sm uppercase tracking-[0.45em] text-white/56 sm:text-base">
            Freeze the feeling
          </p>
          <p className="mt-6 max-w-md text-sm leading-6 text-white/68 sm:text-base">
            Hover a print to catch the parallax. Click one to lift it off the board and fall into the scene.
          </p>
        </div>

        <div className="relative mt-10 h-[70vh] min-h-[620px] w-full">
          {sceneCards.map((scene) => (
            <Polaroid
              key={scene.id}
              scene={scene}
              dimmed={activeScene !== null && activeScene.id !== scene.id}
              hidden={activeScene?.id === scene.id}
              onSelect={openScene}
            />
          ))}
        </div>

        <div className="absolute bottom-6 left-6 z-20 flex flex-col gap-3 sm:bottom-8 sm:left-10 sm:flex-row">
          <button
            onClick={handleUpload}
            className="flex h-13 items-center justify-center rounded-full border border-white/16 bg-white/92 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-black transition hover:scale-[1.03] hover:bg-white"
          >
            Upload Scene
          </button>
          <button
            onClick={() => router.push("/editor")}
            className="flex h-13 items-center justify-center rounded-full border border-white/20 bg-black/18 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-white/78 backdrop-blur-md transition hover:scale-[1.03] hover:border-white/42 hover:text-white"
          >
            Open Editor
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

      {activeScene && activeSceneData ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div
            className="absolute inset-0 bg-[radial-gradient(circle,rgba(0,0,0,0.16),rgba(0,0,0,0.82))] transition-opacity duration-500 ease-out"
            style={{ opacity: zoomed ? 1 : 0 }}
          />
          <div
            className="absolute overflow-hidden rounded-[14px] bg-[#f7f0e6] p-4 pb-8 shadow-[0_40px_120px_rgba(0,0,0,0.65)] transition-[top,left,width,height,transform,border-radius] duration-[850ms] ease-[cubic-bezier(0.2,0.88,0.2,1)]"
            style={{
              top: zoomed ? "50%" : activeScene.rect.top,
              left: zoomed ? "50%" : activeScene.rect.left,
              width: zoomed ? "min(82vw, 760px)" : activeScene.rect.width,
              height: zoomed ? "min(80vh, 900px)" : activeScene.rect.height,
              transform: zoomed ? "translate(-50%, -50%) scale(1.05)" : "translate(0, 0) scale(1)",
              borderRadius: zoomed ? "24px" : "14px",
            }}
          >
            <div
              className="relative h-full w-full overflow-hidden rounded-[8px]"
            >
              <Image
                src={activeSceneData.imageSrc}
                alt={activeSceneData.imageAlt}
                fill
                sizes="82vw"
                priority
                className="object-cover sepia-[0.06] saturate-[0.94]"
                style={{ objectPosition: activeSceneData.imagePosition ?? "center center" }}
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.14),transparent_20%,transparent_70%,rgba(0,0,0,0.28))]" />
              <div
                className="absolute inset-[-10%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.74),transparent_38%)] mix-blend-screen transition-transform duration-[850ms] ease-out"
                style={{ transform: zoomed ? "scale(1.46)" : "scale(1)" }}
              />
              <div
                className="absolute inset-0 transition-transform duration-[900ms] ease-[cubic-bezier(0.2,0.88,0.2,1)]"
                style={{ transform: zoomed ? "scale(1.12)" : "scale(1)" }}
              >
                <div className="absolute bottom-0 left-0 right-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(7,7,7,0.42))]" />
              </div>
              <div
                className="absolute left-6 top-6 transition-[opacity,transform] duration-500 ease-out"
                style={{
                  opacity: zoomed ? 1 : 0,
                  transform: zoomed ? "translateY(0px)" : "translateY(12px)",
                }}
              >
                <div className="text-[0.72rem] uppercase tracking-[0.34em] text-white/72">
                  Scene preview
                </div>
                <div className="mt-3 max-w-[12ch] text-4xl leading-none tracking-[0.04em] text-white">
                  {activeSceneData.title}
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={closeScene}
            className="pointer-events-auto absolute right-6 top-6 rounded-full border border-white/18 bg-black/28 px-4 py-2 text-xs font-medium uppercase tracking-[0.22em] text-white/82 backdrop-blur-md transition hover:bg-black/48 hover:text-white"
          >
            Close
          </button>
        </div>
      ) : null}
    </main>
  );
}
