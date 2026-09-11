import { NextResponse } from "next/server";
import { getBatchCoverArtUrls } from "@/lib/cover-art";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0) : [];
    if (!ids.length) return NextResponse.json({ urls: {} });
    const urls = await getBatchCoverArtUrls(ids.slice(0, 100));
    return NextResponse.json({ urls });
  } catch {
    return NextResponse.json({ urls: {} });
  }
}
