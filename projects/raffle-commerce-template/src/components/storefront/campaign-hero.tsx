import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import type { Campaign, CampaignPrize } from "@prisma/client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { campaignAvailability } from "@/server/campaigns/availability";
import { Countdown } from "./countdown";

type CampaignWithPrizes = Campaign & { prizes: CampaignPrize[] };

export function CampaignHero({ campaign }: { campaign: CampaignWithPrizes }) {
  const prize = campaign.prizes[0];
  const availability = campaignAvailability(campaign);
  return (
    <section className="campaign-hero" aria-labelledby="campaign-hero-title">
      <div className="campaign-hero-media">
        <Image
          src={prize?.image ?? "/demo/giveaway/hero-rig.svg"}
          alt={prize?.name ?? "Current giveaway prize"}
          fill
          loading="eager"
          sizes="100vw"
        />
        <div className="campaign-hero-wash" />
      </div>
      <div className="campaign-hero-content site-container">
        <div className="campaign-hero-copy">
          <p className="campaign-kicker">{campaign.eyebrow ?? "THE CURRENT GIVEAWAY"} <span>{campaign.code}</span></p>
          <h1 id="campaign-hero-title">{campaign.title}</h1>
          <p>{campaign.shortDescription}</p>
          {prize ? (
            <p className="prize-value">Prize package valued at <strong>{formatMoney(prize.approximateValueCents, prize.currency)}</strong></p>
          ) : null}
          <div className="campaign-hero-actions">
            {availability.purchaseEntryOpen ? (
              <Link className="button button-accent" href="/shop">
                Shop & earn entries<ArrowUpRight aria-hidden="true" size={18} />
              </Link>
            ) : availability.freeEntryOpen ? (
              <Link className="button button-accent" href={`/giveaways/${campaign.slug}/free-entry`}>
                Enter without purchase<ArrowUpRight aria-hidden="true" size={18} />
              </Link>
            ) : availability.publicState === "UPCOMING" ? (
              <Link className="button button-accent" href={`/giveaways/${campaign.slug}`}>
                View upcoming giveaway<ArrowUpRight aria-hidden="true" size={18} />
              </Link>
            ) : (
              <Link className="button button-accent" href="/winners">
                View winner updates<ArrowUpRight aria-hidden="true" size={18} />
              </Link>
            )}
            <Link className="button button-glass" href={`/giveaways/${campaign.slug}`}>
              View prize details
            </Link>
          </div>
          <p className="hero-free-entry">
            {availability.freeEntryOpen ? (
              <>No purchase required. <Link href={`/giveaways/${campaign.slug}/free-entry`}>Use the free entry method</Link>.</>
            ) : availability.publicState === "UPCOMING"
              ? `Entry opens ${formatDateTime(campaign.startsAt, campaign.timezone)}.`
              : "This promotion’s entry period has closed. Follow the published verification and winner timeline."}
          </p>
        </div>
        <Countdown
          target={(availability.publicState === "UPCOMING"
            ? campaign.startsAt
            : availability.purchaseEntryOpen ? campaign.endsAt : campaign.freeEntryEndsAt).toISOString()}
          label={availability.publicState === "UPCOMING"
            ? "Entry opens in"
            : availability.purchaseEntryOpen ? "Purchase entries close in" : "Free entry closes in"}
        />
      </div>
      <a className="hero-scroll" href="#featured-products" aria-label="Continue to featured products">
        <ArrowDown aria-hidden="true" size={18} /> Explore
      </a>
    </section>
  );
}
