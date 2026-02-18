import { ParticleCanvas } from "@/components/mandible/particle-canvas"
import { Navbar } from "@/components/mandible/navbar"
import { Hero } from "@/components/mandible/hero"
import { StigmergyLoop } from "@/components/mandible/stigmergy-loop"
import { ConceptsGrid } from "@/components/mandible/concepts-grid"
import { Comparison } from "@/components/mandible/comparison"
import { CodeBlock } from "@/components/mandible/code-block"
import { Waitlist } from "@/components/mandible/waitlist"
import { Footer } from "@/components/mandible/footer"

export default function Home() {
  return (
    <>
      <ParticleCanvas />
      <div className="relative z-[1] mx-auto max-w-[1080px] px-6">
        <Navbar />
        <Hero />
        <StigmergyLoop />
        <ConceptsGrid />
        <Comparison />
        <CodeBlock />
        <Waitlist />
        <Footer />
      </div>
    </>
  )
}
