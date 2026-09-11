import Link from "next/link";

export function SiteNav({
  resultsHref = "/",
  topHref,
  active = "home",
}: {
  resultsHref?: string;
  topHref?: string;
  active?: "home" | "results" | "top";
}) {
  const topLink = topHref ?? resultsHref;
  return (
    <nav className="site-nav" aria-label="Main navigation">
      <Link className="brand-mark" href="/">
        Single Song Challenge
      </Link>
      <div className="nav-links">
        <Link href="/" className={active === "home" ? "active" : undefined}>
          Home
        </Link>
        <Link
          href={resultsHref}
          className={active === "results" ? "active" : undefined}
        >
          Results
        </Link>
        <Link
          href={topLink}
          className={active === "top" ? "active" : undefined}
        >
          Toplist
        </Link>
      </div>
    </nav>
  );
}
