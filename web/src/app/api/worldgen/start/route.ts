import { NextResponse } from "next/server";

const WORLDGEN_API_BASE_URL =
  process.env.WORLDGEN_API_BASE_URL ?? "http://127.0.0.1:18000/api";

export async function POST(request: Request) {
  try {
    const inbound = await request.formData();
    const file = inbound.get("file");
    const model = inbound.get("model");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A file upload is required." }, { status: 400 });
    }

    const outbound = new FormData();
    outbound.append("file", file, file.name);

    if (typeof model === "string" && model.trim()) {
      outbound.append("model", model);
    }

    const response = await fetch(`${WORLDGEN_API_BASE_URL}/worlds:generate`, {
      method: "POST",
      body: outbound,
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as
      | { operation_id?: string; error?: string }
      | null;

    if (!response.ok || !payload?.operation_id) {
      return NextResponse.json(
        { error: payload?.error ?? "Could not start world generation." },
        { status: response.status || 502 },
      );
    }

    return NextResponse.json({ operationId: payload.operation_id });
  } catch {
    return NextResponse.json(
      { error: "Unexpected error while starting world generation." },
      { status: 500 },
    );
  }
}
