export function CodeBlock() {
  return (
    <section id="code" className="pb-24 pt-4">
      <p className="mb-3 text-center text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Minimal API
      </p>
      <p className="mx-auto mb-12 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        Three colonies. Zero coordination code. They self-organize.
      </p>
      <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-border bg-surface">
        {/* Window chrome */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#f87171]/70" aria-hidden="true" />
            <span className="h-3 w-3 rounded-full bg-[#fbbf24]/70" aria-hidden="true" />
            <span className="h-3 w-3 rounded-full bg-primary/70" aria-hidden="true" />
          </div>
          <span className="font-mono text-xs text-muted-foreground">pipeline.ts</span>
        </div>

        {/* Code */}
        <div className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
          <pre className="m-0">
            <span className="text-muted-foreground/50">{"// Three colonies. Zero coordination code."}</span>
{"\n\n"}
<span className="text-[#a78bfa]">{"const"}</span>{" shaper = "}<span className="text-[#60a5fa]">{"colony"}</span>{"("}<span className="text-primary">{"'shaper'"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"in"}</span>{"(env)"}
{"\n  ."}<span className="text-[#60a5fa]">{"sense"}</span>{"("}<span className="text-primary">{"'task:ready'"}</span>{", { unclaimed: "}<span className="text-[#a78bfa]">{"true"}</span>{" })"}
{"\n  ."}<span className="text-[#60a5fa]">{"do"}</span>{"("}<span className="text-primary">{"'shape'"}</span>{", "}<span className="text-[#60a5fa]">{"withAgent"}</span>{"({"}
{"\n    model: "}<span className="text-primary">{"'claude-sonnet-4-5-20250929'"}</span>{","}
{"\n    tools: ["}<span className="text-primary">{"'file_edit'"}</span>{", "}<span className="text-primary">{"'bash'"}</span>{"],"}
{"\n    output: { type: "}<span className="text-primary">{"'artifact:shaped'"}</span>{" },"}
{"\n  }))"}
{"\n  ."}<span className="text-[#60a5fa]">{"concurrency"}</span>{"("}<span className="text-[#fbbf24]">{"3"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"build"}</span>{"();"}
{"\n\n"}
<span className="text-[#a78bfa]">{"const"}</span>{" critic = "}<span className="text-[#60a5fa]">{"colony"}</span>{"("}<span className="text-primary">{"'critic'"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"in"}</span>{"(env)"}
{"\n  ."}<span className="text-[#60a5fa]">{"sense"}</span>{"("}<span className="text-primary">{"'artifact:shaped'"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"do"}</span>{"("}<span className="text-primary">{"'review'"}</span>{", "}<span className="text-[#60a5fa]">{"withStructuredOutput"}</span>{"({"}
{"\n    model: "}<span className="text-primary">{"'gpt-4o'"}</span>{","}
{"\n    schema: ReviewSchema,"}
{"\n    route: (r) "}<span className="text-foreground">{"=>"}</span>{" r.approved"}
{"\n      ? "}<span className="text-primary">{"'review:approved'"}</span>
{"\n      : "}<span className="text-primary">{"'review:changes-needed'"}</span>{","}
{"\n  }))"}
{"\n  ."}<span className="text-[#60a5fa]">{"build"}</span>{"();"}
{"\n\n"}
<span className="text-[#a78bfa]">{"const"}</span>{" keeper = "}<span className="text-[#60a5fa]">{"colony"}</span>{"("}<span className="text-primary">{"'keeper'"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"in"}</span>{"(env)"}
{"\n  ."}<span className="text-[#60a5fa]">{"sense"}</span>{"("}<span className="text-primary">{"'review:approved'"}</span>{")"}
{"\n  ."}<span className="text-[#60a5fa]">{"do"}</span>{"("}<span className="text-primary">{"'merge'"}</span>{", "}<span className="text-[#60a5fa]">{"withBash"}</span>{"({"}
{"\n    command: (s) "}<span className="text-foreground">{"=>"}</span>{" "}<span className="text-primary">{"`git merge ${s.payload.branch}`"}</span>{","}
{"\n  }))"}
{"\n  ."}<span className="text-[#60a5fa]">{"build"}</span>{"();"}
          </pre>
        </div>
      </div>
    </section>
  )
}
