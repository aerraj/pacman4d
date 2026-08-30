import { describe, expect, it } from 'vitest';
import { collapseOnObservation, decayWhenUnobserved, forcePowerMeasurement, PHYSICS, QuantumState } from './physics';

describe('quantum ghost transitions', () => {
  it('collapses superposition and entanglement under observation', () => {
    expect(collapseOnObservation(QuantumState.SUPERPOSITION)).toBe(QuantumState.DECOHERED);
    expect(collapseOnObservation(QuantumState.ENTANGLED)).toBe(QuantumState.DECOHERED);
  });

  it('preserves tunneling when merely observed', () => {
    expect(collapseOnObservation(QuantumState.TUNNELING)).toBe(QuantumState.TUNNELING);
  });

  it('returns a decohered ghost to superposition after four unobserved seconds', () => {
    expect(decayWhenUnobserved(QuantumState.DECOHERED, PHYSICS.unobservedDecayMs - 1)).toBe(QuantumState.DECOHERED);
    expect(decayWhenUnobserved(QuantumState.DECOHERED, PHYSICS.unobservedDecayMs)).toBe(QuantumState.SUPERPOSITION);
  });

  it('treats every power pellet as a forced classical measurement', () => {
    expect(forcePowerMeasurement()).toBe(QuantumState.DECOHERED);
  });
});
