import Link from "next/link"

function MandibleIcon() {
  return (
    <svg
      className="h-7 w-7 text-primary"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M16 2 L6 10 L6 14 C6 14 4 16 4 18 C4 21 6 22 6 22 L10 26 L14 28 L16 30 L18 28 L22 26 L26 22 C26 22 28 21 28 18 C28 16 26 14 26 14 L26 10 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M11 14 L16 10 L21 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="18" r="2" fill="currentColor" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4 fill-current" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export function Navbar() {
  return (
    <nav className="flex items-center justify-between py-6">
      <Link
        href="/"
        className="flex items-center gap-2.5 text-foreground no-underline"
      >
        <MandibleIcon />
        <span className="text-base font-semibold tracking-tight">Mandible</span>
      </Link>
      <div className="flex items-center gap-6">
        <Link
          href="#concepts"
          className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          Concepts
        </Link>
        <Link
          href="#code"
          className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          Code
        </Link>
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm text-muted-foreground transition-all hover:border-foreground/20 hover:text-foreground"
        >
          <GitHubIcon />
          <span className="hidden sm:inline">GitHub</span>
        </a>
      </div>
    </nav>
  )
}
