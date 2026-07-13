import { clsx } from "clsx";
import { Container } from "@/components/ui/container";

export function PageHero({
  eyebrow,
  title,
  description,
  children,
  tone = "dark",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
  tone?: "dark" | "accent" | "light";
}) {
  return (
    <section className={clsx("page-hero", `page-hero-${tone}`)}>
      <Container>
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {children ? <div className="page-hero-aside">{children}</div> : null}
      </Container>
    </section>
  );
}
