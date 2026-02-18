"use client"

import { useEffect, useState } from "react"

const steps = [
  { label: "Sense", description: "Agents observe environment signals" },
  { label: "Match", description: "Signals match agent capabilities" },
  { label: "Claim", description: "Agent claims work atomically" },
  { label: "Act", description: "Agent performs the task" },
  { label: "Deposit", description: "New signals left in environment" },
  { label: "Repeat", description: "Other agents sense the new signals" },
]

export function StigmergyLoop() {
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % steps.length)
    }, 1800)
    return () => clearInterval(interval)
  }, [])

  return (
    <section className="pb-24 pt-4">
      <p className="mb-3 text-center text-sm font-medium uppercase tracking-widest text-muted-foreground">
        The Stigmergy Loop
      </p>
      <p className="mx-auto mb-10 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        No orchestrator. No message broker. Complex workflows emerge from simple rules.
      </p>

      <div className="mx-auto max-w-2xl">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {steps.map((step, i) => (
            <div key={step.label} className="flex items-center gap-2">
              <button
                onClick={() => setActiveIdx(i)}
                className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-300 ${
                  i === activeIdx
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-surface text-muted-foreground hover:border-foreground/10 hover:text-foreground"
                } ${i === steps.length - 1 ? "italic" : ""}`}
              >
                {step.label}
              </button>
              {i < steps.length - 1 && (
                <svg className={`h-4 w-4 shrink-0 transition-colors duration-300 ${i === activeIdx ? "text-primary" : "text-border"}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground transition-all duration-300">
            {steps[activeIdx].description}
          </p>
        </div>
      </div>
    </section>
  )
}
