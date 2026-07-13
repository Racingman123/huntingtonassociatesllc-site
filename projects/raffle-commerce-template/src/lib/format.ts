export function isTwoDecimalCurrency(currency: string) {
  try {
    if (!Intl.supportedValuesOf("currency").includes(currency)) return false;
    const options = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions();
    return options.minimumFractionDigits === 2 && options.maximumFractionDigits === 2;
  } catch {
    return false;
  }
}

export function formatMoney(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatEntries(entries: bigint | number | string) {
  const value = typeof entries === "bigint" ? entries : BigInt(entries);
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDateTime(date: Date, timezone = "America/New_York") {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(date);
}

export function titleCase(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
