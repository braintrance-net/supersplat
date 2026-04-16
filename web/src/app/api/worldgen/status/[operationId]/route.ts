import { NextResponse } from "next/server";

const WORLDGEN_API_BASE_URL =
  process.env.WORLDGEN_API_BASE_URL ?? "http://127.0.0.1:18000/api";

type OperationPayload = {
  done?: boolean;
  metadata?: {
    progress?: string;
  };
  response?: {
    world_id?: string;
  } | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

type WorldPayload = {
  assets?: {
    splats?: {
      spz_urls?: Record<string, string>;
    };
  };
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  try {
    const { operationId } = await context.params;
    const response = await fetch(`${WORLDGEN_API_BASE_URL}/operations/${operationId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Could not read world generation status." },
        { status: response.status || 502 },
      );
    }

    const payload = (await response.json()) as OperationPayload;
    const worldId = payload.response?.world_id ?? null;
    let primarySpzUrl: string | null = null;

    if (payload.done && !payload.error?.message && worldId) {
      const worldResponse = await fetch(`${WORLDGEN_API_BASE_URL}/worlds/${worldId}`, {
        cache: "no-store",
      });

      if (worldResponse.ok) {
        const worldPayload = (await worldResponse.json()) as WorldPayload;
        const urls = worldPayload.assets?.splats?.spz_urls ?? {};
        primarySpzUrl = Object.values(urls)[0] ?? null;
      }
    }

    return NextResponse.json({
      done: Boolean(payload.done),
      progress: payload.metadata?.progress ?? null,
      error: payload.error ?? null,
      worldId,
      primarySpzUrl,
    });
  } catch {
    return NextResponse.json(
      { error: "Unexpected error while checking world generation status." },
      { status: 500 },
    );
  }
}
