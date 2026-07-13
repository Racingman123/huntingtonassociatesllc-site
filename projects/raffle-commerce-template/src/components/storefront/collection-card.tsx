import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Collection } from "@prisma/client";

export function CollectionCard({ collection, index }: { collection: Collection; index: number }) {
  return (
    <Link className={`collection-card collection-card-${(index % 4) + 1}`} href={`/collections/${collection.slug}`}>
      {collection.image ? <Image src={collection.image} alt="" fill sizes="(max-width: 760px) 100vw, 50vw" /> : null}
      <span className="collection-card-shade" />
      <span className="collection-card-content">
        <small>0{index + 1}</small>
        <strong>{collection.title}</strong>
        <span>{collection.description}</span>
      </span>
      <ArrowUpRight aria-hidden="true" size={28} />
    </Link>
  );
}
