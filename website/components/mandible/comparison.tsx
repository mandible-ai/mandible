import { X, Check } from "lucide-react"

const oldWay = [
  "Agents must know who to talk to",
  "Coordination scales O(n\u00B2)",
  "Orchestrator failure halts everything",
  "State scattered across agent memories",
  "Adding agents means rewiring",
]

const newWay = [
  "Agents only interact with the environment",
  "Coordination scales O(n)",
  "Agent dies, signal remains, another picks up",
  "Environment IS the state — ls to debug",
  "Add colonies with zero config changes",
]

export function Comparison() {
  return (
    <section className="pb-24 pt-4">
      <p className="mb-3 text-center text-sm font-medium uppercase tracking-widest text-muted-foreground">
        A Different Architecture
      </p>
      <p className="mx-auto mb-12 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        Stop building fragile pipelines. Let coordination emerge from the environment.
      </p>
      <div className="mx-auto grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Old way */}
        <div className="rounded-xl border border-destructive/15 bg-destructive/[0.04] p-6">
          <div className="mb-5 flex items-center gap-2 text-sm font-semibold text-destructive">
            <X className="h-4 w-4" />
            Message Passing
          </div>
          <ul className="flex flex-col gap-3">
            {oldWay.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive/40" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* New way */}
        <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-6">
          <div className="mb-5 flex items-center gap-2 text-sm font-semibold text-primary">
            <Check className="h-4 w-4" />
            Stigmergy
          </div>
          <ul className="flex flex-col gap-3">
            {newWay.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
