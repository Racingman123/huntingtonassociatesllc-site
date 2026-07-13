import type { Route } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { clsx } from "clsx";

export function ButtonLink<T extends string>({
  href,
  children,
  className,
  variant = "primary",
  arrow = false,
}: {
  href: Route<T>;
  children: React.ReactNode;
  className?: string;
  variant?: "primary" | "secondary" | "light" | "ghost";
  arrow?: boolean;
}) {
  return (
    <Link className={clsx("button", `button-${variant}`, className)} href={href}>
      <span>{children}</span>
      {arrow ? <ArrowUpRight aria-hidden="true" size={18} strokeWidth={2.2} /> : null}
    </Link>
  );
}
