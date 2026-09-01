import { describe, expect, it } from 'vitest';
import { allocateResources, minimumCostCoordinate } from './optimizer';

describe('tactical resource optimizer', () => {
  it('moves resources toward defense as trajectory threat rises', () => {
    expect(allocateResources(0)).toEqual({ defense: 20, offense: 80 });
    expect(allocateResources(100)).toEqual({ defense: 82, offense: 18 });
  });

  it('chooses the coordinate with minimum projected damage cost', () => {
    const cells = [{ id: 'near', damage: 9 }, { id: 'safe', damage: 1 }, { id: 'costly', damage: 5 }];
    expect(minimumCostCoordinate(cells, cell => cell.damage)?.id).toBe('safe');
  });
});
