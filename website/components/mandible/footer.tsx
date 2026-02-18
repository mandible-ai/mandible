export function Footer() {
  return (
    <footer className="flex flex-col items-center justify-between gap-4 border-t border-border py-8 sm:flex-row">
      <span className="text-xs text-muted-foreground">
        Mandible &copy; 2026 Sparrow Labs
      </span>
      <div className="flex items-center gap-5">
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          GitHub
        </a>
        <a
          href="#"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Docs
        </a>
        <a
          href="#"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Blog
        </a>
      </div>
    </footer>
  )
}
