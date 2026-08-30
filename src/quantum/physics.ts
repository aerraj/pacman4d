export enum QuantumState {
  SUPERPOSITION = 'SUPERPOSITION',
  ENTANGLED = 'ENTANGLED',
  TUNNELING = 'TUNNELING',
  DECOHERED = 'DECOHERED',
}

export const PHYSICS = {
  fixedStep: 1 / 60,
  playerStepMs: 118,
  ghostStepMs: 300,
  superpositionStepMs: 430,
  decoheredSpeedMultiplier: 1.1,
  unobservedDecayMs: 4000,
  sustainedObservationMs: 900,
  powerPelletMs: 8000,
  stateRotationMs: 30000,
  tunnelProbability: 0.15,
  tunnelCooldownMs: 3000,
  braneShiftCooldownMs: 500,
  braneImmunityMs: 200,
  observationConeCosine: Math.cos(Math.PI / 4),
} as const;

export const STATE_GLYPHS: Record<QuantumState, string> = {
  [QuantumState.SUPERPOSITION]: 'ψ',
  [QuantumState.ENTANGLED]: '⊗',
  [QuantumState.TUNNELING]: 'τ',
  [QuantumState.DECOHERED]: 'Δ',
};

export function collapseOnObservation(state: QuantumState): QuantumState {
  return state === QuantumState.SUPERPOSITION || state === QuantumState.ENTANGLED
    ? QuantumState.DECOHERED
    : state;
}

export function decayWhenUnobserved(state: QuantumState, elapsedMs: number): QuantumState {
  return state === QuantumState.DECOHERED && elapsedMs >= PHYSICS.unobservedDecayMs
    ? QuantumState.SUPERPOSITION
    : state;
}

export function forcePowerMeasurement(): QuantumState {
  return QuantumState.DECOHERED;
}
