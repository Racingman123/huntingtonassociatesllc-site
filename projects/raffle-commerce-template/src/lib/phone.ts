import { z } from "zod";

const formattedPhoneSchema = z.string()
  .trim()
  .min(1, "Enter a phone number")
  .max(64, "Phone number is too long")
  .refine(
    (value) => /^\+?[0-9().\-\s]+$/.test(value),
    "Use only digits and common phone punctuation",
  )
  .refine(
    (value) => {
      const digitCount = value.replace(/\D/g, "").length;
      return digitCount >= 7 && digitCount <= 20;
    },
    "Enter a phone number with 7 to 20 digits",
  );

/**
 * Accepts familiar display formatting but emits only an optional leading `+`
 * followed by digits. The application persists this canonical form.
 */
export const phoneSchema = formattedPhoneSchema.transform((value) => {
  const digits = value.replace(/\D/g, "");
  return `${value.startsWith("+") ? "+" : ""}${digits}`;
});

export function normalizePhone(value: string) {
  return phoneSchema.parse(value);
}
