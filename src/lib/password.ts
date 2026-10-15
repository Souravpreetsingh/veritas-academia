import bcrypt from "bcryptjs";

// Cost factor 12: strong enough for password storage while remaining fast on
// modest hardware. Raise for production if your infrastructure allows it.
const SALT_ROUNDS = 12;

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

/** Constant-time-ish comparison that never throws on malformed hashes. */
export async function verifyPassword(
  plainText: string,
  storedHash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plainText, storedHash);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  valid: boolean;
  error?: string;
}

/** Server-side password policy. The same rules must apply to every entry point. */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters long." };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password must be 128 characters or fewer." };
  }
  return { valid: true };
}

export interface EmailPolicyResult {
  valid: boolean;
  normalized?: string;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): EmailPolicyResult {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) {
    return { valid: false, error: "Enter a valid email address." };
  }
  if (!EMAIL_PATTERN.test(normalized)) {
    return { valid: false, error: "Enter a valid email address." };
  }
  return { valid: true, normalized };
}
