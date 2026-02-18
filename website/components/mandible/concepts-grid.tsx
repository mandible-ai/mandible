import { Beaker, Globe, Bug, Brain, Wind, Sparkles } from "lucide-react"

const concepts = [
  {
    icon: Beaker,
    title: "Signals as Pheromones",
    description:
      "Agents leave typed, structured signals in the environment. Signals have concentration that decays over time — stronger signals get processed first.",
  },
  {
    icon: Globe,
    title: "Environment is State",
    description:
      "Filesystem, database, GitHub, Kubernetes — any shared substrate becomes a coordination layer. Observable, debuggable, and persistent.",
  },
  {
    icon: Bug,
    title: "Colonies, Not Agents",
    description:
      "Groups of identical agents with shared rules. Stateless and replaceable. Scale by increasing concurrency — no rewiring required.",
  },
  {
    icon: Brain,
    title: "Pluggable Intelligence",
    description:
      "Each colony uses the minimum LLM it needs. Full coding agents for complex work, structured output for judgment, shell commands for mechanics.",
  },
  {
    icon: Wind,
    title: "Pheromone Decay",
    description:
      "Signals weaken and evaporate over time. No stale work, no unbounded queues. The system naturally recovers from abandoned tasks.",
  },
  {
    icon: Sparkles,
    title: "Emergent Behavior",
    description:
      "Self-healing, load balancing, quality convergence — none of it is programmed. It arises from simple colonies following simple rules.",
  },
]

export function ConceptsGrid() {
  return (
    <section id="concepts" className="pb-24 pt-4">
      <p className="mb-3 text-center text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Built on Biological Principles
      </p>
      <p className="mx-auto mb-12 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        Mandible borrows coordination patterns from ant colonies and other swarm systems.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {concepts.map((concept) => (
          <div
            key={concept.title}
            className="group rounded-xl border border-border bg-surface p-6 transition-all duration-200 hover:border-primary/20 hover:bg-primary/[0.03]"
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors">
                <concept.icon className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">
                {concept.title}
              </h3>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{concept.description}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
