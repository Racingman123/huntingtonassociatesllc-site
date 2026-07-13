import Link from "next/link";
import Image from "next/image";

export function Logo({
  label = "GIVEAWAY",
  image,
  imageAlt,
}: {
  label?: string;
  image?: string;
  imageAlt?: string;
}) {
  return (
    <Link className="brand-logo" href="/" aria-label={`${imageAlt || label} home`}>
      {image ? (
        <Image className="brand-logo-image" src={image} alt="" width={220} height={64} />
      ) : (
        <>
          <span className="brand-logo-mark" aria-hidden="true"><span /></span>
          <span>{label}</span>
        </>
      )}
    </Link>
  );
}
