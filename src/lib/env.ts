// Server-side environment access with fail-fast validation.
//
// Every required variable is checked with a descriptive error that points at
// `.env.example`, so a missing value never surfaces as an opaque runtime crash
// deep inside Prisma or next-auth.

export class EnvironmentError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing or empty environment variable${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill in the required values, then restart the server.`,
    );
    this.name = "EnvironmentError";
  }
}

/** Read a variable, treating whitespace-only values as unset. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Read a variable or throw a descriptive error. */
export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (value === undefined) throw new EnvironmentError([name]);
  return value;
}

/** Read several variables, reporting every missing one at once. */
export function requireEnvGroup(names: string[]): Record<string, string> {
  const missing = names.filter((name) => readEnv(name) === undefined);
  if (missing.length > 0) throw new EnvironmentError(missing);
  return Object.fromEntries(names.map((name) => [name, readEnv(name) as string]));
}

/** Absolute base URL of the application, used for links and callbacks. */
export function appUrl(): string {
  return readEnv("NEXT_PUBLIC_APP_URL") ?? readEnv("NEXTAUTH_URL") ?? "http://localhost:3000";
}
