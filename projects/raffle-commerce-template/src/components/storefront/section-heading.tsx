import Link from "next/link";
import type { Route } from "next";
import { ArrowRight } from "lucide-react";
import { clsx } from "clsx";

export function SectionHeading<T extends string>({
  eyebrow,
  title,
  description,
  href,
  linkLabel = "View all",
  inverse = false,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  href?: Route<T>;
  linkLabel?: string;
  inverse?: boolean;
}) {
  return (
    <header className={clsx("section-heading", inverse && "section-heading-inverse")}>
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {description ? <p className="section-description">{description}</p> : null}
      </div>
      {href ? (
        <Link className="text-link" href={href}>
          {linkLabel}<ArrowRight aria-hidden="true" size={18} />
        </Link>
      ) : null}
    </header>
  );
}
