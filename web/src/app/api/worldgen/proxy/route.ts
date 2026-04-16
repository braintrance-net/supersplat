import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const upstreamUrl = searchParams.get("url");
    const requestedFilename = searchParams.get("filename");

    if (!upstreamUrl) {
      return NextResponse.json({ error: "Missing upstream URL." }, { status: 400 });
    }

    const response = await fetch(upstreamUrl, {
      cache: "no-store",
    });

    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: "Could not fetch generated splat." },
        { status: response.status || 502 },
      );
    }

    const filename =
      requestedFilename ||
      upstreamUrl.split("/").pop()?.split("?")[0] ||
      "generated-world.spz";

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Unexpected error while proxying generated splat." },
      { status: 500 },
    );
  }
}
