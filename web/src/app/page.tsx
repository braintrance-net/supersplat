"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
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
  translateX: number;
  translateY: number;
  scale: number;
};

const sceneCards: SceneCard[] = [
  {
    id: "gallery",
    title: "Opening Night",
    transform: "translate(-12vw, -7vh) rotate(-13deg)",
    widthClassName: "w-[224px] sm:w-[246px] lg:w-[268px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "50% 56%",
    titleClassName: `${caveat.className} rotate-[-2deg] text-[1.72rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "vegas",
    title: "Vegas Blur",
    transform: "translate(18vw, -9vh) rotate(7deg)",
    widthClassName: "w-[214px] sm:w-[236px] lg:w-[252px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "56% 48%",
    titleClassName: `${patrick.className} rotate-[1deg] text-[1.36rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "boat",
    title: "Boat Sunset",
    transform: "translate(83vw, -4vh) rotate(14deg)",
    widthClassName: "w-[232px] sm:w-[258px] lg:w-[280px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${shadows.className} rotate-[-1deg] text-[1.52rem] font-normal tracking-[0.015em]`,
  },
  {
    id: "gallery-echo",
    title: "After Hours",
    transform: "translate(-8vw, 67vh) rotate(11deg)",
    widthClassName: "w-[220px] sm:w-[244px] lg:w-[262px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "16% 55%",
    titleClassName: `${gloria.className} rotate-[2deg] text-[1.28rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "vegas-echo",
    title: "Neon Hour",
    transform: "translate(78vw, 61vh) rotate(-8deg)",
    widthClassName: "w-[216px] sm:w-[238px] lg:w-[256px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "60% 60%",
    titleClassName: `${kalam.className} rotate-[-3deg] text-[1.48rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "boat-echo",
    title: "Golden Water",
    transform: "translate(34vw, 73vh) rotate(-16deg)",
    widthClassName: "w-[228px] sm:w-[250px] lg:w-[270px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${indie.className} rotate-[2deg] text-[1.42rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "quiet-corner",
    title: "Keep This",
    transform: "translate(86vw, 25vh) rotate(5deg)",
    widthClassName: "w-[198px] sm:w-[220px] lg:w-[236px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "78% 44%",
    titleClassName: `${sue.className} rotate-[-1deg] text-[1.9rem] font-normal tracking-[0.005em]`,
  },
  {
    id: "strip-memory",
    title: "City Static",
    transform: "translate(-6vw, 28vh) rotate(6deg)",
    widthClassName: "w-[176px] sm:w-[196px] lg:w-[214px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "66% 46%",
    titleClassName: `${kalam.className} rotate-[1deg] text-[1.24rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "red-room",
    title: "Red Room",
    transform: "translate(8vw, -12vh) rotate(15deg)",
    widthClassName: "w-[188px] sm:w-[208px] lg:w-[224px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "8% 52%",
    titleClassName: `${gloria.className} rotate-[-2deg] text-[1.16rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "late-checkin",
    title: "Late Check-In",
    transform: "translate(47vw, -11vh) rotate(-11deg)",
    widthClassName: "w-[182px] sm:w-[202px] lg:w-[216px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "54% 38%",
    titleClassName: `${caveat.className} rotate-[1deg] text-[1.42rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "wine-wall",
    title: "Wine Wall",
    transform: "translate(63vw, -8vh) rotate(8deg)",
    widthClassName: "w-[170px] sm:w-[188px] lg:w-[206px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "92% 48%",
    titleClassName: `${patrick.className} rotate-[2deg] text-[1.18rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "soft-focus",
    title: "Soft Focus",
    transform: "translate(92vw, 6vh) rotate(-9deg)",
    widthClassName: "w-[186px] sm:w-[206px] lg:w-[222px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${indie.className} rotate-[-2deg] text-[1.3rem] font-medium tracking-[0.018em]`,
  },
  {
    id: "aisle-light",
    title: "Aisle Light",
    transform: "translate(22vw, 24vh) rotate(-14deg)",
    widthClassName: "w-[164px] sm:w-[182px] lg:w-[194px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "42% 34%",
    titleClassName: `${sue.className} rotate-[1deg] text-[1.66rem] font-normal tracking-[0.01em]`,
  },
  {
    id: "blue-hour",
    title: "Blue Hour",
    transform: "translate(58vw, 26vh) rotate(13deg)",
    widthClassName: "w-[178px] sm:w-[198px] lg:w-[214px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "48% 58%",
    titleClassName: `${shadows.className} rotate-[-1deg] text-[1.34rem] font-normal tracking-[0.016em]`,
  },
  {
    id: "half-remembered",
    title: "Half Remembered",
    transform: "translate(88vw, 48vh) rotate(17deg)",
    widthClassName: "w-[172px] sm:w-[192px] lg:w-[208px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "68% 60%",
    titleClassName: `${caveat.className} rotate-[2deg] text-[1.3rem] font-bold tracking-[0.012em]`,
  },
  {
    id: "dock-heat",
    title: "Dock Heat",
    transform: "translate(-10vw, 76vh) rotate(-7deg)",
    widthClassName: "w-[184px] sm:w-[204px] lg:w-[222px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${kalam.className} rotate-[1deg] text-[1.22rem] font-bold tracking-[0.014em]`,
  },
  {
    id: "corner-store",
    title: "Corner Store",
    transform: "translate(16vw, 80vh) rotate(12deg)",
    widthClassName: "w-[176px] sm:w-[194px] lg:w-[210px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "72% 54%",
    titleClassName: `${gloria.className} rotate-[-1deg] text-[1.12rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "static-air",
    title: "Static Air",
    transform: "translate(76vw, 78vh) rotate(-12deg)",
    widthClassName: "w-[180px] sm:w-[198px] lg:w-[214px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "34% 58%",
    titleClassName: `${patrick.className} rotate-[1deg] text-[1.18rem] font-medium tracking-[0.02em]`,
  },
];

const filmGrain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.22'/%3E%3C/svg%3E\")";

const paperTexture =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E\")";

const EXPANDED_POLAROID_WIDTH = "min(42vw, 420px)";

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

  useEffect(() => {
    const uniqueSources = [...new Set(sceneCards.map((scene) => scene.imageSrc))];

    uniqueSources.forEach((src) => {
      const image = new window.Image();
      image.decoding = "async";
      image.src = src;
    });
  }, []);

  const activeSceneData = useMemo(
    () => sceneCards.find((scene) => scene.id === activeScene?.id) ?? null,
    [activeScene?.id],
  );

  const openScene = (id: string, rect: DOMRect) => {
    setZoomed(false);
    const targetWidth = Math.min(window.innerWidth * 0.42, 420);
    const scale = targetWidth / rect.width;
    const rectCenterX = rect.left + rect.width / 2;
    const rectCenterY = rect.top + rect.height / 2;
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;

    setActiveScene({
      id,
      rect,
      translateX: viewportCenterX - rectCenterX,
      translateY: viewportCenterY - rectCenterY,
      scale,
    });

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
    <main className="relative h-screen overflow-hidden bg-[#120f11] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(96,73,61,0.95)_0%,rgba(27,21,24,0.88)_30%,#120f11_68%)]" />
      <div className="absolute inset-0 opacity-55 bg-[linear-gradient(115deg,rgba(241,226,196,0.08),transparent_26%,transparent_72%,rgba(255,255,255,0.05)),repeating-linear-gradient(90deg,rgba(255,255,255,0.03)_0,rgba(255,255,255,0.03)_1px,transparent_1px,transparent_120px),repeating-linear-gradient(0deg,rgba(255,255,255,0.025)_0,rgba(255,255,255,0.025)_1px,transparent_1px,transparent_110px)]" />
      <div
        className="absolute inset-0 opacity-20 mix-blend-soft-light"
        style={{ backgroundImage: paperTexture }}
      />

      <section className="relative z-10 h-full px-4 py-4 sm:px-6 sm:py-6">
        <div className="relative h-full w-full">
          {sceneCards.map((scene) => (
            <Polaroid
              key={scene.id}
              scene={scene}
              dimmed={activeScene !== null && activeScene.id !== scene.id}
              hidden={activeScene?.id === scene.id}
              onSelect={openScene}
            />
          ))}

          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4">
            <div className="pointer-events-auto w-full max-w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-[28px] border border-white/12 bg-white/10 px-6 py-7 text-center shadow-[0_30px_120px_rgba(0,0,0,0.38)] backdrop-blur-xl sm:px-10 sm:py-9">
              <div className="flex justify-center">
                <Image
                  src="/images/logo.svg"
                  alt="BrainTrance logo"
                  width={220}
                  height={56}
                  className="h-14 w-auto opacity-90"
                  style={{ filter: "brightness(0) invert(1)" }}
                />
              </div>
              <h1
                className="mt-5 max-w-full text-[clamp(2rem,5.8vw,3.9rem)] font-bold leading-[0.92] tracking-0 text-white"
                style={{ fontFamily: "var(--font-display)", transform: "scaleX(0.88)" }}
              >
                BrainTrance
              </h1>
              <p className="mt-3 text-sm uppercase tracking-[0.45em] text-white/56 sm:text-base">
                Freeze the feeling
              </p>
              <p className="mx-auto mt-5 max-w-md text-sm leading-6 text-white/72 sm:text-base">
                Hover a print to catch the parallax. Click one to lift it off the board and fall into the scene.
              </p>
              <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <button
                  onClick={handleUpload}
                  className="flex h-13 min-w-[184px] items-center justify-center rounded-full border border-white/16 bg-white/92 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-black transition hover:scale-[1.03] hover:bg-white"
                >
                  Upload Scene
                </button>
                <button
                  onClick={() => router.push("/editor")}
                  className="flex h-13 min-w-[184px] items-center justify-center rounded-full border border-white/20 bg-black/18 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-white/82 backdrop-blur-md transition hover:scale-[1.03] hover:border-white/42 hover:text-white"
                >
                  Open Editor
                </button>
              </div>
            </div>
          </div>
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
            className="absolute rounded-[14px] bg-[#f7f0e6] p-3 pb-6 shadow-[0_40px_120px_rgba(0,0,0,0.65)] transition-[top,left,width,height,transform,border-radius] duration-[850ms] ease-[cubic-bezier(0.2,0.88,0.2,1)]"
            style={{
              top: activeScene.rect.top,
              left: activeScene.rect.left,
              width: activeScene.rect.width,
              height: activeScene.rect.height,
              transform: zoomed
                ? `translate(${activeScene.translateX}px, ${activeScene.translateY}px) scale(${activeScene.scale})`
                : "translate(0px, 0px) scale(1)",
              transformOrigin: "center center",
              borderRadius: "14px",
              willChange: "transform",
            }}
          >
            <div
              className="relative overflow-hidden rounded-[6px]"
              style={{ height: "calc(100% - 4.3rem)" }}
            >
              <Image
                src={activeSceneData.imageSrc}
                alt={activeSceneData.imageAlt}
                fill
                sizes="42vw"
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
                <div className="absolute bottom-0 left-0 right-0 h-24 bg-[linear-gradient(180deg,transparent,rgba(7,7,7,0.42))]" />
              </div>
            </div>
            <div className="flex h-[4.3rem] items-center justify-center px-3 text-center">
              <div className={`${activeSceneData.titleClassName} text-center leading-none text-stone-800`}>
                {activeSceneData.title}
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
