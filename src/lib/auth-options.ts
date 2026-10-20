import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import { verifyPassword, normalizeEmail } from "@/lib/password";
import { isRole } from "@/lib/domain";
import { readEnv } from "@/lib/env";

// A pre-computed bcrypt hash of a random value. When the account does not exist
// we still run a comparison against this hash, so sign-in latency does not leak
// whether an email address is registered (timing-based user enumeration).
const DUMMY_PASSWORD_HASH =
  "$2b$12$Yhgb52s8/ZnsFZg49RZWSeYff3yM/HsZxsNuGycbogEUiSLoXiaSq";

// Session invalidation / suspension strategy (documented for the team):
// - Sessions are JWTs (encrypted JWE cookies) with a 7-day maxAge.
// - The JWT carries id + role for fast UI decisions ONLY.
// - Authoritative role and suspension state are re-read from the database on
//   every protected request via requireUser()/requireRole() in src/lib/session.ts,
//   so suspending a user takes effect immediately without waiting for token expiry.
// - Rotating AUTH_SECRET invalidates every outstanding session at once.
export const authOptions: NextAuthOptions = {
  secret: readEnv("AUTH_SECRET") ?? readEnv("NEXTAUTH_SECRET"),
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = normalizeEmail(credentials.email);
        if (!email.valid || !email.normalized) return null;

        const user = await prisma.user.findUnique({
          where: { email: email.normalized },
        });

        // Always perform a bcrypt comparison — against a dummy hash when the
        // account is missing — so response timing does not reveal whether the
        // email exists. All failure paths return the same generic null.
        const valid = await verifyPassword(
          credentials.password,
          user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        );

        // Reject unknown or suspended accounts outright, even with a valid password.
        if (!user || user.suspended) return null;
        if (!valid) return null;

        if (!isRole(user.role)) return null;

        // Fire-and-forget login timestamp; never blocks sign-in.
        void prisma.user
          .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
          .catch(() => undefined);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid ?? "";
        session.user.role = token.role ?? "STUDENT";
      }
      return session;
    },
  },
};
