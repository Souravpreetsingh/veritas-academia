import type { NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth-options";
import { guardCredentialsCallback } from "@/lib/rate-limit-guard";

const handler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth: string[] }> };

// Credentials sign-in is rate-limited before NextAuth processes it; every other
// auth request (session, signout, ...) is delegated unchanged. A limited
// request never reaches the user table, so the 429/503 response cannot reveal
// whether an account exists (see src/lib/rate-limit-guard.ts).
export async function POST(request: NextRequest, context: RouteContext) {
  const limited = await guardCredentialsCallback(request);
  if (limited) return limited;
  return handler(request, context);
}

export { handler as GET };
