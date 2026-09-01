export function allocateResources(threat: number) {
  const normalizedThreat = Math.max(0, Math.min(100, threat));
  const defense = Math.max(20, Math.min(82, Math.round(20 + normalizedThreat * 0.68)));
  return { defense, offense: 100 - defense };
}

export function minimumCostCoordinate<T>(candidates: T[], cost: (candidate: T) => number): T | undefined {
  let best: T | undefined;
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const nextCost = cost(candidate);
    if (nextCost < bestCost) { best = candidate; bestCost = nextCost; }
  }
  return best;
}
