"use client"

import { useState, type FormEvent } from "react"
import { Check } from "lucide-react"

export function Waitlist() {
  const [submitted, setSubmitted] = useState(false)
  const [email, setEmail] = useState("")

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitted(true)
    setEmail("")
    setTimeout(() => setSubmitted(false), 3000)
  }

  return (
    <section id="waitlist" className="pb-24 pt-10 text-center">
      <h2 className="mb-3 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Get early access
      </h2>
      <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-muted-foreground">
        Mandible is in active development. Join the waitlist for updates and early access to the framework.
      </p>
      <form
        onSubmit={handleSubmit}
        className="mx-auto flex max-w-md flex-col items-center gap-3 sm:flex-row"
      >
        <input
          type="email"
          placeholder="you@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
        />
        <button
          type="submit"
          className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-all sm:w-auto ${
            submitted
              ? "bg-primary/20 text-primary"
              : "bg-primary text-primary-foreground hover:brightness-110"
          }`}
        >
          {submitted ? (
            <>
              <Check className="h-4 w-4" />
              Subscribed
            </>
          ) : (
            "Notify me"
          )}
        </button>
      </form>
    </section>
  )
}
