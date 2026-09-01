# PACMAN 4D
URL : https://pacman4d.vercel.app/
## Abstract

We report a reproducible maze experiment in which four spectral agents obey a deliberately playful approximation of quantum mechanics. The player acts as both subject and observer: a clear line of sight collapses a probability cloud into a deterministic, faster pursuer. The experiment runs entirely in the browser on a fixed 60 Hz simulation loop, requires no backend, and exposes its live state through an instrumentation panel.

## 1. Introduction

Classic maze pursuit assumes that every participant has a definite position. PACMAN 4D asks the less comfortable question: what if the ghosts do not choose a corridor until somebody looks? The result is a playable interpretation of superposition, entanglement, tunneling, and decoherence, presented as a mid-century research instrument annotated by a Renaissance natural philosopher.

## 2. Methods

The maze contains two parallel manifolds, Brane A and Brane B. Photons must be collected on both.

| State | Symbol | Implemented behavior |
| --- | --- | --- |
| Superposition | ψ | Four weighted candidate tiles diffuse every 430 ms. Observation samples one candidate and collapses the ghost. |
| Entangled | ⊗ | Pairs 0↔1 and 2↔3 mirror across the vertical maze axis. Measuring either collapses both. |
| Tunneling | τ | A 15% opportunity to cross one interior barrier, subject to a 3 s cooldown; this state can also cross branes. |
| Decohered | Δ | Deterministic pursuit at 1.1× nominal speed. Four unobserved seconds restore superposition. |

The observation field is a 90° cone aligned with the player’s current direction. Maze barriers occlude it. A power pellet is treated as measurement apparatus: it forces all ghosts into a frightened, decohered state for 8 s. Quantum assignments rotate every 30 s.

### Adaptive tactical system

Every 750 ms, the engine serializes player, ghost, trajectory, state, and reserve information into a live JSON telemetry packet and parses it through a tactical evaluator. The evaluator projects each ghost’s next four tile steps, weights the projection by quantum state, penalizes low-exit corridors, and creates a normalized trajectory-threat score.

When threat rises, the resource allocator moves a larger share of its 100-point budget toward defense and spends reserves on temporary lattice barriers at predicted breach coordinates. At lower threat, resources return to offense, increasing movement efficiency and photon/ghost score yield. Following a collision, every viable maze coordinate is evaluated for predicted damage, escape routes, nearby resources, and travel cost; the minimum-cost coordinate becomes the next spawn point.

## 3. Controls

- Arrow keys or `WASD`: move
- `Space`: shift between branes (500 ms cooldown, 200 ms collision immunity)
- `P` or `Escape`: suspend/resume the experiment
- `Enter`: begin or repeat a trial
- Touch: swipe to move, tap the maze or use `Φ` to shift branes

## 4. Reproducibility

Each run displays and stores its integer seed in the URL as `?seed=...`. Opening the same URL reproduces the same pseudo-random sequence of diffusion, frightened choices, state motion, and tunneling opportunities. High score and sound preference persist in local storage.

## 5. Implementation

The interface uses React, TypeScript, and a Canvas renderer. Simulation and rendering are isolated in `src/game`; quantum constants live in `src/quantum/physics.ts`. Audio is synthesized with Web Audio and ships with no media payload. EB Garamond and JetBrains Mono are self-hosted.

Production: [pacman4d.vercel.app](https://pacman4d.vercel.app)

## References

1. Namco, *Pac-Man*, 1980.
2. aerraj, [Pacman](https://github.com/aerraj/Pacman), prior browser implementation consulted as inspiration only; no source code was modified or copied.
