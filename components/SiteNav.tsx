import Link from "next/link";

export function SiteNav({
  resultsHref = "/",
  active = "home",
}: {
  resultsHref?: string;
  active?: "home" | "results";
}) {
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
      </div>
    </nav>
  );
}
