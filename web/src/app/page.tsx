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
  zIndex?: number;
  imageSrc: string;
  imageAlt: string;
  imagePosition?: string;
  titleClassName: string;
};

type ActiveScene = {
  id: string;
  rect: DOMRect;
  offsetX: number;
  offsetY: number;
  startScale: number;
  targetWidth: number;
  targetHeight: number;
  startRotate: number;
};

type MarbleModelOption = {
  label: string;
  value: string;
};

type WorldgenStartResponse = {
  operationId: string;
};

type WorldgenStatusResponse = {
  done: boolean;
  progress?: string;
  error?: {
    code?: string;
    message?: string;
  } | null;
  worldId?: string | null;
  primarySpzUrl?: string | null;
};

const supportedWorldgenImageExtensions = [".bmp", ".jpeg", ".jpg", ".png", ".tiff", ".webp"];
const supportedWorldgenVideoExtensions = [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"];
const supportedWorldgenExtensions = [
  ...supportedWorldgenImageExtensions,
  ...supportedWorldgenVideoExtensions,
];

const marbleModelOptions: MarbleModelOption[] = [
  {
    label: "Draft",
    value: "marble-1.0-draft",
  },
  {
    label: "Mini",
    value: "marble-1.0",
  },
  {
    label: "1.1",
    value: "marble-1.1",
  },
  {
    label: "Pro",
    value: "marble-1.1-plus",
  },
];

const sceneCards: SceneCard[] = [
  {
    id: "gallery",
    title: "Opening Night",
    transform: "translate(-12vw, -7vh) rotate(-13deg)",
    widthClassName: "w-[224px] sm:w-[242px] lg:w-[258px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "50% 56%",
    titleClassName: `${caveat.className} rotate-[-2deg] text-[1.72rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "vegas",
    title: "Vegas Blur",
    transform: "translate(18vw, -9vh) rotate(7deg)",
    widthClassName: "w-[220px] sm:w-[238px] lg:w-[254px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "56% 48%",
    titleClassName: `${patrick.className} rotate-[1deg] text-[1.36rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "boat",
    title: "Boat Sunset",
    transform: "translate(83vw, -4vh) rotate(14deg)",
    widthClassName: "w-[230px] sm:w-[248px] lg:w-[264px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${shadows.className} rotate-[-1deg] text-[1.52rem] font-normal tracking-[0.015em]`,
  },
  {
    id: "gallery-echo",
    title: "After Hours",
    transform: "translate(-8vw, 67vh) rotate(11deg)",
    widthClassName: "w-[222px] sm:w-[240px] lg:w-[256px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "16% 55%",
    titleClassName: `${gloria.className} rotate-[2deg] text-[1.28rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "vegas-echo",
    title: "Neon Hour",
    transform: "translate(78vw, 61vh) rotate(-8deg)",
    widthClassName: "w-[220px] sm:w-[238px] lg:w-[254px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "60% 60%",
    titleClassName: `${kalam.className} rotate-[-3deg] text-[1.48rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "boat-echo",
    title: "Golden Water",
    transform: "translate(34vw, 73vh) rotate(-16deg)",
    widthClassName: "w-[226px] sm:w-[244px] lg:w-[260px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${indie.className} rotate-[2deg] text-[1.42rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "quiet-corner",
    title: "Keep This",
    transform: "translate(86vw, 25vh) rotate(5deg)",
    widthClassName: "w-[214px] sm:w-[232px] lg:w-[248px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "78% 44%",
    titleClassName: `${sue.className} rotate-[-1deg] text-[1.9rem] font-normal tracking-[0.005em]`,
  },
  {
    id: "strip-memory",
    title: "City Static",
    transform: "translate(-6vw, 28vh) rotate(6deg)",
    widthClassName: "w-[212px] sm:w-[228px] lg:w-[242px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "66% 46%",
    titleClassName: `${kalam.className} rotate-[1deg] text-[1.24rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "red-room",
    title: "Red Room",
    transform: "translate(8vw, -12vh) rotate(15deg)",
    widthClassName: "w-[216px] sm:w-[232px] lg:w-[246px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "8% 52%",
    titleClassName: `${gloria.className} rotate-[-2deg] text-[1.16rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "late-checkin",
    title: "Late Check-In",
    transform: "translate(47vw, -11vh) rotate(-11deg)",
    widthClassName: "w-[214px] sm:w-[230px] lg:w-[244px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "54% 38%",
    titleClassName: `${caveat.className} rotate-[1deg] text-[1.42rem] font-bold tracking-[0.01em]`,
  },
  {
    id: "wine-wall",
    title: "Wine Wall",
    transform: "translate(63vw, -8vh) rotate(8deg)",
    widthClassName: "w-[210px] sm:w-[226px] lg:w-[240px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "92% 48%",
    titleClassName: `${patrick.className} rotate-[2deg] text-[1.18rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "soft-focus",
    title: "Soft Focus",
    transform: "translate(92vw, 6vh) rotate(-9deg)",
    widthClassName: "w-[214px] sm:w-[230px] lg:w-[244px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${indie.className} rotate-[-2deg] text-[1.3rem] font-medium tracking-[0.018em]`,
  },
  {
    id: "aisle-light",
    title: "Aisle Light",
    transform: "translate(22vw, 24vh) rotate(-14deg)",
    widthClassName: "w-[208px] sm:w-[224px] lg:w-[238px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "42% 34%",
    titleClassName: `${sue.className} rotate-[1deg] text-[1.66rem] font-normal tracking-[0.01em]`,
  },
  {
    id: "blue-hour",
    title: "Blue Hour",
    transform: "translate(58vw, 26vh) rotate(13deg)",
    widthClassName: "w-[212px] sm:w-[228px] lg:w-[242px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "48% 58%",
    titleClassName: `${shadows.className} rotate-[-1deg] text-[1.34rem] font-normal tracking-[0.016em]`,
  },
  {
    id: "half-remembered",
    title: "Half Remembered",
    transform: "translate(88vw, 48vh) rotate(17deg)",
    widthClassName: "w-[210px] sm:w-[226px] lg:w-[240px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "68% 60%",
    titleClassName: `${caveat.className} rotate-[2deg] text-[1.3rem] font-bold tracking-[0.012em]`,
  },
  {
    id: "dock-heat",
    title: "Dock Heat",
    transform: "translate(-10vw, 76vh) rotate(-7deg)",
    widthClassName: "w-[216px] sm:w-[232px] lg:w-[246px]",
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${kalam.className} rotate-[1deg] text-[1.22rem] font-bold tracking-[0.014em]`,
  },
  {
    id: "corner-store",
    title: "Corner Store",
    transform: "translate(16vw, 80vh) rotate(12deg)",
    widthClassName: "w-[212px] sm:w-[228px] lg:w-[242px]",
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "72% 54%",
    titleClassName: `${gloria.className} rotate-[-1deg] text-[1.12rem] font-normal tracking-[0.03em]`,
  },
  {
    id: "static-air",
    title: "Static Air",
    transform: "translate(76vw, 78vh) rotate(-12deg)",
    widthClassName: "w-[214px] sm:w-[230px] lg:w-[244px]",
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "34% 58%",
    titleClassName: `${patrick.className} rotate-[1deg] text-[1.18rem] font-medium tracking-[0.02em]`,
  },
  {
    id: "center-hush",
    title: "Still Warm",
    transform: "translate(17vw, 33vh) rotate(-27deg)",
    widthClassName: "w-[238px] sm:w-[256px] lg:w-[274px]",
    zIndex: 14,
    imageSrc: "/images/reference-gallery.jpg",
    imageAlt: "Gallery interior panorama",
    imagePosition: "36% 52%",
    titleClassName: `${caveat.className} rotate-[1deg] text-[1.42rem] font-bold tracking-[0.012em]`,
  },
  {
    id: "center-sun",
    title: "No Vacancy",
    transform: "translate(58vw, 32vh) rotate(22deg)",
    widthClassName: "w-[232px] sm:w-[250px] lg:w-[268px]",
    zIndex: 15,
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "58% 46%",
    titleClassName: `${kalam.className} rotate-[-2deg] text-[1.34rem] font-bold tracking-[0.014em]`,
  },
  {
    id: "center-floor",
    title: "Last Light",
    transform: "translate(38vw, 61vh) rotate(-19deg)",
    widthClassName: "w-[244px] sm:w-[262px] lg:w-[280px]",
    zIndex: 14,
    imageSrc: "/images/polaroids.jpg",
    imageAlt: "Reference polaroid image",
    imagePosition: "center center",
    titleClassName: `${shadows.className} rotate-[1deg] text-[1.42rem] font-normal tracking-[0.016em]`,
  },
  {
    id: "center-flicker",
    title: "Blue Motel",
    transform: "translate(33vw, 16vh) rotate(18deg)",
    widthClassName: "w-[228px] sm:w-[246px] lg:w-[262px]",
    zIndex: 13,
    imageSrc: "/images/reference-vegas.jpg",
    imageAlt: "Person wearing sunglasses on Las Vegas strip",
    imagePosition: "66% 42%",
    titleClassName: `${indie.className} rotate-[-1deg] text-[1.34rem] font-medium tracking-[0.018em]`,
  },
];

const filmGrain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.22'/%3E%3C/svg%3E\")";

const paperTexture =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E\")";

const getRotationFromTransform = (transform: string) => {
  const match = transform.match(/rotate\(([-\d.]+)deg\)/);
  return match ? Number(match[1]) : 0;
};

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
  const cardRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const frameRef = useRef<number | null>(null);

  const baseTransform = scene.transform;

  const applyHoverFrame = () => {
    frameRef.current = null;

    const card = cardRef.current;
    const glare = glareRef.current;
    if (!card || !glare) return;

    const { x, y } = pointerRef.current;
    const rotateX = (y - 0.5) * -10;
    const rotateY = (x - 0.5) * 12;

    card.style.transform = `perspective(1100px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.035)`;
    glare.style.transform = `translate(${(x - 0.5) * 24}px, ${(y - 0.5) * 24}px)`;
  };

  const queueHoverFrame = () => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(applyHoverFrame);
  };

  const settleHoverState = () => {
    pointerRef.current = { x: 0.5, y: 0.5 };
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (ref.current) {
      ref.current.style.transform = baseTransform;
    }
    if (cardRef.current) {
      cardRef.current.style.transform =
        "perspective(1100px) rotateX(0deg) rotateY(0deg) scale(1)";
    }
    if (glareRef.current) {
      glareRef.current.style.transform = "translate(0px, 0px)";
    }
  };

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open ${scene.title}`}
      className={[
        "absolute cursor-pointer select-none text-left outline-none transition-[opacity,filter,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
        scene.widthClassName,
        hidden ? "pointer-events-none opacity-0 scale-90" : dimmed ? "opacity-15" : "opacity-100",
      ].join(" ")}
      style={{
        transform: baseTransform,
        zIndex: scene.zIndex,
        willChange: "transform",
      }}
      onPointerEnter={() => {
        if (ref.current) {
          ref.current.style.transform = `${baseTransform} translateY(-12px)`;
        }
        queueHoverFrame();
      }}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        pointerRef.current = {
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        };
        queueHoverFrame();
      }}
      onPointerLeave={() => {
        settleHoverState();
      }}
      onClick={() => {
        const rect = ref.current?.getBoundingClientRect();
        settleHoverState();
        if (rect) onSelect(scene.id, rect);
      }}
    >
      <div
        ref={cardRef}
        className="rounded-[10px] bg-[#f7f0e6] p-3 pb-6 shadow-[0_28px_80px_rgba(0,0,0,0.42),0_8px_18px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out"
        style={{ transform: "perspective(1100px) rotateX(0deg) rotateY(0deg) scale(1)", willChange: "transform" }}
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
            ref={glareRef}
            className="absolute inset-[-12%] opacity-55 mix-blend-screen transition-transform duration-300 ease-out"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.56), transparent 38%)",
              transform: "translate(0px, 0px)",
              willChange: "transform",
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
  const splatInputRef = useRef<HTMLInputElement>(null);
  const worldgenInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [activeScene, setActiveScene] = useState<ActiveScene | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(marbleModelOptions[0]!.value);
  const [isWorldgenLoading, setIsWorldgenLoading] = useState(false);
  const [worldgenProgress, setWorldgenProgress] = useState("idle");
  const [worldgenFileName, setWorldgenFileName] = useState<string | null>(null);
  const [worldgenError, setWorldgenError] = useState<string | null>(null);
  const [worldgenResultUrl, setWorldgenResultUrl] = useState<string | null>(null);
  const [worldgenOperationId, setWorldgenOperationId] = useState<string | null>(null);

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
    const targetHeight = rect.height * (targetWidth / rect.width);
    const rectCenterX = rect.left + rect.width / 2;
    const rectCenterY = rect.top + rect.height / 2;
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;

    setActiveScene({
      id,
      rect,
      offsetX: rectCenterX - viewportCenterX,
      offsetY: rectCenterY - viewportCenterY,
      startScale: rect.width / targetWidth,
      targetWidth,
      targetHeight,
      startRotate: getRotationFromTransform(
        sceneCards.find((scene) => scene.id === id)?.transform ?? "",
      ),
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

  const resetWorldgenState = () => {
    setIsWorldgenLoading(false);
    setWorldgenProgress("idle");
    setWorldgenError(null);
    setWorldgenOperationId(null);
  };

  const pollWorldgenOperation = async (operationId: string) => {
    while (true) {
      const response = await fetch(`/api/worldgen/status/${operationId}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Could not read world generation status.");
      }

      const payload = (await response.json()) as WorldgenStatusResponse;
      setWorldgenProgress(payload.progress ?? "running");

      if (payload.done) {
        if (payload.error?.message) {
          throw new Error(payload.error.message);
        }

        if (!payload.primarySpzUrl) {
          throw new Error("World generation finished without a splat URL.");
        }

        setWorldgenProgress("ready");
        setWorldgenResultUrl(payload.primarySpzUrl);
        setIsWorldgenLoading(false);
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  };

  const handleSplatUpload = () => {
    splatInputRef.current?.click();
  };

  const handleWorldgenUpload = () => {
    worldgenInputRef.current?.click();
  };

  const handleSplatFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    (window as Window & { __pendingFile?: File }).__pendingFile = file;
    e.target.value = "";
    router.push("/editor");
  };

  const handleWorldgenFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const extension = file.name.includes(".")
      ? `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`
      : "";

    if (!supportedWorldgenExtensions.includes(extension)) {
      setWorldgenFileName(file.name);
      setWorldgenResultUrl(null);
      setWorldgenOperationId(null);
      setWorldgenProgress("failed");
      setWorldgenError(
        `Unsupported file type '${extension || "unknown"}'. Accepted images: ${supportedWorldgenImageExtensions.join(", ")}. Accepted videos: ${supportedWorldgenVideoExtensions.join(", ")}.`,
      );
      setIsWorldgenLoading(false);
      e.target.value = "";
      return;
    }

    setWorldgenError(null);
    setWorldgenResultUrl(null);
    setWorldgenOperationId(null);
    setWorldgenFileName(file.name);
    setWorldgenProgress("uploading");
    setIsWorldgenLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("model", selectedModel);

      // Keep inpainting enabled by not setting skip_inpaint=true.
      const response = await fetch("/api/worldgen/start", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not start world generation.");
      }

      const payload = (await response.json()) as WorldgenStartResponse;
      setWorldgenOperationId(payload.operationId);
      setWorldgenProgress("queued");
      await pollWorldgenOperation(payload.operationId);
    } catch (error) {
      setWorldgenError(error instanceof Error ? error.message : "Could not start world generation.");
      setWorldgenProgress("failed");
      setIsWorldgenLoading(false);
    } finally {
      e.target.value = "";
    }
  };

  const handleOpenEditorWithWorld = () => {
    if (!worldgenResultUrl) return;
    router.push(`/editor?load=${encodeURIComponent(worldgenResultUrl)}`);
  };

  const worldgenStatusCopy = (() => {
    switch (worldgenProgress) {
      case "uploading":
        return "Uploading source media";
      case "queued":
        return "Queued for world generation";
      case "running":
        return "Inpainting and generating world";
      case "ready":
        return "World ready";
      case "failed":
        return "Generation failed";
      default:
        return "Preparing world generation";
    }
  })();

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
            <div className="pointer-events-auto w-full max-w-[min(620px,calc(100vw-2rem))] overflow-hidden rounded-[28px] border border-white/12 bg-white/10 px-6 py-7 text-center shadow-[0_30px_120px_rgba(0,0,0,0.38)] backdrop-blur-xl sm:px-10 sm:py-9">
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

              <div className="mx-auto mt-7 max-w-[520px] rounded-[24px] border border-white/10 bg-black/20 p-4 text-left">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={handleSplatUpload}
                    className="rounded-[22px] border border-white/16 bg-white/92 px-5 py-5 text-left text-black transition hover:scale-[1.02] hover:bg-white"
                  >
                    <div className="text-lg font-semibold leading-tight">
                      Upload Splat
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleWorldgenUpload}
                    className="rounded-[22px] border border-white/20 bg-black/18 px-5 py-5 text-left text-white/88 backdrop-blur-md transition hover:scale-[1.02] hover:border-white/42 hover:text-white"
                  >
                    <div className="text-lg font-semibold leading-tight">
                      Upload 2D
                    </div>
                  </button>
                </div>

                <div className="mt-4 flex items-center gap-3 rounded-[18px] border border-white/8 bg-white/4 px-3 py-3">
                  <label
                    htmlFor="marble-model"
                    className="shrink-0 text-[0.68rem] uppercase tracking-[0.32em] text-white/46"
                  >
                    Marble Model
                  </label>
                  <div className="grid flex-1 grid-cols-4 gap-2">
                    {marbleModelOptions.map((option) => {
                      const isSelected = option.value === selectedModel;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setSelectedModel(option.value)}
                          className={[
                            "rounded-[14px] border px-3 py-2 text-center transition",
                            isSelected
                              ? "border-[#f4d6b2] bg-[#f4d6b2] text-black"
                              : "border-white/12 bg-white/6 text-white/78 hover:border-white/28 hover:bg-white/10",
                          ].join(" ")}
                        >
                          <div className="text-xs font-semibold uppercase tracking-[0.22em]">
                            {option.label}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => router.push("/editor")}
                  className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/5 px-5 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-white/52 transition hover:border-white/22 hover:bg-white/8 hover:text-white/82"
                >
                  Open Editor
                </button>
              </div>
            </div>
          </div>
        </div>

        <input
          ref={splatInputRef}
          type="file"
          accept=".ply,.splat,.spz"
          onChange={handleSplatFileChange}
          className="hidden"
        />

        <input
          ref={worldgenInputRef}
          type="file"
          accept={supportedWorldgenExtensions.join(",")}
          onChange={handleWorldgenFileChange}
          className="hidden"
        />
      </section>

      {activeScene && activeSceneData ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div
            className="absolute inset-0 bg-[radial-gradient(circle,rgba(0,0,0,0.16),rgba(0,0,0,0.82))] transition-opacity duration-500 ease-out"
            style={{
              opacity: zoomed ? 1 : 0,
              transitionDelay: zoomed ? "90ms" : "0ms",
            }}
          />
          <div
            className="fixed rounded-[14px] bg-[#f7f0e6] p-3 pb-6 shadow-[0_40px_120px_rgba(0,0,0,0.65)] transition-transform duration-[680ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{
              top: "50%",
              left: "50%",
              width: activeScene.targetWidth,
              height: activeScene.targetHeight,
              transform: zoomed
                ? "translate3d(-50%, -50%, 0) scale(1) rotate(0deg)"
                : `translate3d(calc(-50% + ${activeScene.offsetX}px), calc(-50% + ${activeScene.offsetY}px), 0) scale(${activeScene.startScale}) rotate(${activeScene.startRotate}deg)`,
              transformOrigin: "center center",
              borderRadius: "14px",
              willChange: "transform",
              backfaceVisibility: "hidden",
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

      {(isWorldgenLoading || worldgenError || worldgenResultUrl) ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[radial-gradient(circle,rgba(12,9,11,0.58),rgba(4,4,5,0.92))] px-4 backdrop-blur-md">
          <div className="w-full max-w-[560px] rounded-[30px] border border-white/10 bg-[#171217]/90 p-7 text-center shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
            <div className="text-[0.7rem] uppercase tracking-[0.34em] text-white/42">
              World Generation
            </div>
            <h2 className="mt-4 text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[0.95] text-white">
              {worldgenResultUrl ? "Your world is ready." : "Building your scene."}
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-white/66 sm:text-base">
              {worldgenResultUrl
                ? "The generated splat is ready to load into the editor."
                : "Uploading your media, inpainting the scene, and generating a world from the selected Marble model."}
            </p>

            <div className="mt-6 rounded-[22px] border border-white/8 bg-white/5 p-5 text-left">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[0.68rem] uppercase tracking-[0.28em] text-white/42">
                    Source
                  </div>
                  <div className="mt-2 text-sm font-medium text-white/86">
                    {worldgenFileName ?? "Selected media"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[0.68rem] uppercase tracking-[0.28em] text-white/42">
                    Model
                  </div>
                  <div className="mt-2 text-sm font-medium text-white/86">
                    {marbleModelOptions.find((option) => option.value === selectedModel)?.label ?? "Draft"}
                  </div>
                </div>
              </div>

              <div className="mt-5">
                <div className="flex items-center justify-between text-[0.72rem] uppercase tracking-[0.26em] text-white/46">
                  <span>Status</span>
                  <span>{worldgenStatusCopy}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={[
                      "h-full rounded-full bg-[linear-gradient(90deg,#f4d6b2,#f5f1db)] transition-all duration-700",
                      worldgenResultUrl ? "w-full" : worldgenError ? "w-1/3" : "animate-pulse",
                    ].join(" ")}
                    style={{
                      width: worldgenResultUrl
                        ? "100%"
                        : worldgenError
                          ? "34%"
                          : worldgenProgress === "uploading"
                            ? "18%"
                            : worldgenProgress === "queued"
                              ? "34%"
                              : worldgenProgress === "running"
                                ? "72%"
                                : "10%",
                    }}
                  />
                </div>
              </div>

              {worldgenOperationId ? (
                <div className="mt-4 text-xs text-white/40">
                  Operation ID: {worldgenOperationId}
                </div>
              ) : null}

              {worldgenError ? (
                <div className="mt-4 rounded-[16px] border border-[#ff8c8c]/20 bg-[#5b1c24]/30 px-4 py-3 text-sm leading-5 text-[#ffd6d6]">
                  {worldgenError}
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {worldgenResultUrl ? (
                <button
                  type="button"
                  onClick={handleOpenEditorWithWorld}
                  className="flex h-13 min-w-[214px] items-center justify-center rounded-full border border-white/16 bg-white/92 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-black transition hover:scale-[1.03] hover:bg-white"
                >
                  Open Editor
                </button>
              ) : null}

              <button
                type="button"
                onClick={resetWorldgenState}
                className="flex h-13 min-w-[184px] items-center justify-center rounded-full border border-white/20 bg-black/18 px-7 text-sm font-semibold uppercase tracking-[0.22em] text-white/82 backdrop-blur-md transition hover:scale-[1.03] hover:border-white/42 hover:text-white"
              >
                {worldgenResultUrl || worldgenError ? "Close" : "Hide"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
