import Link from "next/link"

export function Hero() {
  return (
    <section className="pb-28 pt-24 text-center sm:pt-32">
      <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2 text-sm text-muted-foreground">
        <span
          className="h-2 w-2 rounded-full bg-primary"
          style={{ animation: "pulse-dot 2s ease-in-out infinite" }}
          aria-hidden="true"
        />
        <span className="font-medium text-primary">v0.1 alpha</span>
        <span className="h-3.5 w-px bg-border" aria-hidden="true" />
        <span>Coming soon</span>
      </div>

      <h1 className="mx-auto mb-6 max-w-3xl text-balance text-4xl font-bold leading-[1.1] tracking-[-1.5px] sm:text-5xl lg:text-6xl">
        Stop wiring agents.
        <br />
        <span className="text-primary">
          Let them self-organize.
        </span>
      </h1>

      <p className="mx-auto mb-10 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
        Mandible is a stigmergy framework for autonomous agents.
        Agents coordinate by reading from and writing to a shared
        environment — not by talking to each other.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="#waitlist"
          className="inline-flex items-center rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110"
        >
          Get early access
        </Link>
        <Link
          href="#code"
          className="inline-flex items-center rounded-lg border border-border px-6 py-3 text-sm font-medium text-foreground transition-all hover:bg-surface"
        >
          View example
        </Link>
      </div>
    </section>
  )
}
