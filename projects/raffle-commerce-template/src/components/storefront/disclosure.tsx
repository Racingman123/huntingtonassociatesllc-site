import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { clsx } from "clsx";
import type { OfficialRulesHref } from "@/lib/official-rules";

export function Disclosure({
  text = "NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING.",
  campaignSlug,
  officialRulesHref,
  compact = false,
  className,
}: {
  text?: string;
  campaignSlug: string;
  officialRulesHref: OfficialRulesHref;
  compact?: boolean;
  className?: string;
}) {
  return (
    <aside className={clsx("disclosure", compact && "disclosure-compact", className)} aria-label="Sweepstakes disclosure">
      <ShieldCheck aria-hidden="true" size={compact ? 17 : 22} />
      <p>
        <strong>{text}</strong>{" "}
        <span>Void where prohibited. Eligibility restrictions apply.</span>{" "}
        <Link href={officialRulesHref}>Official Rules</Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/giveaways/${campaignSlug}/free-entry`}>Free entry</Link>
      </p>
    </aside>
  );
}
