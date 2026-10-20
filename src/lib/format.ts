// Pure display helpers, free of any server imports, so they are safe to use
// from both server components and client components.

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Render minor units (e.g. paise) as a human price, without inventing digits. */
export function formatMoney(amountMinor: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const hasFraction = amountMinor % 100 !== 0;
  const major = amountMinor / 100;
  const formatted = major.toLocaleString("en-US", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

/** Human turnaround label derived from the real service turnaroundHours. */
export function formatTurnaround(hours: number): string {
  if (hours < 2) return "Within 1 hour";
  return `Within ${hours} hours`;
}
