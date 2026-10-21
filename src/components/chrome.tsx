import Link from "next/link";
import { site } from "@/lib/site";

export function Logo({ light = true }: { light?: boolean }) {
  return (
    <Link href="/" className={`logo ${light ? "light" : ""}`} aria-label="Earmark home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 3h15l8 8v18H5z" fill="#ede1d0" stroke="#ede1d0" strokeWidth="2" strokeLinejoin="round" />
        <path d="M20 3v8h8z" fill="#fff387" stroke="#1a1b1f" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 18h12M10 23h8" stroke="#1a1b1f" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span>earmark</span>
    </Link>
  );
}

export function Arrow() {
  return (
    <span className="go" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d="M2 8h11M8.5 3.5 13 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
      />
    </svg>
  );
}

export function Nav({ signedIn = false, href }: { signedIn?: boolean; href: string }) {
  return (
    <nav className="nav" aria-label="Main">
      <Logo />
      <div className="nav-links">
        <Link href="/#problem">Problem</Link>
        <Link href="/#how">How it works</Link>
        <Link href="/#api">API</Link>
        <Link href="/#questions">Questions</Link>
      </div>
      <div className="nav-actions">
        <a className="icon-btn" href={site.repo} aria-label="Earmark on GitHub">
          <GitHubIcon />
        </a>
        <a className="nav-cta" href={href}>
          {signedIn ? "Dashboard" : "Log in"}
        </a>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-in">
        <div className="footer-brand">
          <Logo />
          <p>{site.tagline}</p>
        </div>
        <div className="footer-cols">
          <div>
            <h2>Learn</h2>
            <Link href="/#problem">The problem</Link>
            <Link href="/#how">How it works</Link>
            <Link href="/#api">API</Link>
            <Link href="/#questions">Questions</Link>
          </div>
          <div>
            <h2>Project</h2>
            <a href={site.repo}>GitHub</a>
            <a href={`${site.repo}/blob/main/CONTRIBUTING.md`}>Contributing</a>
            <a href={`${site.repo}/blob/main/SECURITY.md`}>Security</a>
            <a href={`${site.repo}/blob/main/LICENSE`}>License</a>
          </div>
        </div>
      </div>
      <p className="footer-note">Open source on GitHub. Limits and billing by Kinde.</p>
    </footer>
  );
}
