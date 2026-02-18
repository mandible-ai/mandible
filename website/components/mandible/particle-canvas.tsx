"use client"

import { useEffect, useRef } from "react"

const PARTICLE_COUNT = 40
const TRAIL_DISTANCE = 120

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  life: number
  decay: number
}

function createParticle(w: number, h: number): Particle {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.15,
    vy: (Math.random() - 0.5) * 0.15,
    r: Math.random() * 1.5 + 0.5,
    life: Math.random(),
    decay: 0.0001 + Math.random() * 0.0003,
  }
}

function resetParticle(p: Particle, w: number, h: number) {
  p.x = Math.random() * w
  p.y = Math.random() * h
  p.vx = (Math.random() - 0.5) * 0.15
  p.vy = (Math.random() - 0.5) * 0.15
  p.r = Math.random() * 1.5 + 0.5
  p.life = Math.random()
  p.decay = 0.0001 + Math.random() * 0.0003
}

export function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let w = (canvas.width = window.innerWidth)
    let h = (canvas.height = window.innerHeight)

    const particles: Particle[] = []
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(createParticle(w, h))
    }

    function handleResize() {
      w = canvas!.width = window.innerWidth
      h = canvas!.height = window.innerHeight
    }
    window.addEventListener("resize", handleResize)

    let animId: number

    function animate() {
      ctx!.clearRect(0, 0, w, h)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        p.life -= p.decay

        if (p.life <= 0 || p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) {
          resetParticle(p, w, h)
        }

        ctx!.beginPath()
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(52,211,153,${p.life * 0.08})`
        ctx!.fill()
      }

      // Subtle trails
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < TRAIL_DISTANCE) {
            const alpha =
              (1 - dist / TRAIL_DISTANCE) *
              0.025 *
              Math.min(particles[i].life, particles[j].life)
            ctx!.beginPath()
            ctx!.moveTo(particles[i].x, particles[i].y)
            ctx!.lineTo(particles[j].x, particles[j].y)
            ctx!.strokeStyle = `rgba(52,211,153,${alpha})`
            ctx!.lineWidth = 0.5
            ctx!.stroke()
          }
        }
      }

      animId = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      window.removeEventListener("resize", handleResize)
      cancelAnimationFrame(animId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
      aria-hidden="true"
    />
  )
}
