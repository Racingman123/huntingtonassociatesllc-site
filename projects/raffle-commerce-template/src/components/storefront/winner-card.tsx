import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Campaign, CampaignPrize, Winner } from "@prisma/client";

export type PublishedWinner = Winner & { campaign: Campaign; prize: CampaignPrize };

export function WinnerCard({ winner, featured = false }: { winner: PublishedWinner; featured?: boolean }) {
  return (
    <article className={featured ? "winner-card winner-card-featured" : "winner-card"}>
      <Link className="winner-card-media" href={`/winners/${winner.slug}`}>
        <Image src={winner.image ?? winner.prize.image ?? "/demo/winners/winner-1.svg"} alt="" fill sizes={featured ? "(max-width: 800px) 100vw, 58vw" : "33vw"} />
        <span>{winner.campaign.code}</span>
      </Link>
      <div className="winner-card-body">
        <p className="eyebrow">Verified winner</p>
        <h3>{winner.publicName}</h3>
        <p>{winner.publicLocation}</p>
        <strong>{winner.prize.name}</strong>
        <Link className="text-link" href={`/winners/${winner.slug}`}>Read their story <ArrowRight aria-hidden="true" size={17} /></Link>
      </div>
    </article>
  );
}
