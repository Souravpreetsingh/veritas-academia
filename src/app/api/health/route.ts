import { NextResponse } from "next/server";
import { databaseHealthy } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform health check (Render web service).
 *
 * Returns 200 only while the process can reach the database; 503 otherwise so
 * the platform withholds traffic from an instance that cannot serve requests.
 * The response contains no secrets, versions, or error details.
 */
export async function GET() {
  const databaseUp = await databaseHealthy();

  return NextResponse.json(
    {
      status: databaseUp ? "ok" : "unavailable",
      database: databaseUp ? "up" : "down",
    },
    {
      status: databaseUp ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
