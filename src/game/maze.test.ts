import { describe, expect, it } from 'vitest';
import { MAZE_A, MAZE_B } from './maze';

describe('spectral house entrance', () => {
  it.each([[MAZE_A], [MAZE_B]])('keeps a four-tile gate and an open route into the house', maze => {
    expect(maze[12].slice(12, 16)).toBe('====');
    expect(maze[16].slice(12, 16)).toBe('====');

    for (let x = 12; x <= 15; x += 1) {
      expect(maze[11][x]).not.toBe('#');
      expect(maze[12][x]).not.toBe('#');
      expect(maze[13][x]).not.toBe('#');
      expect(maze[14][x]).not.toBe('#');
      expect(maze[15][x]).not.toBe('#');
      expect(maze[16][x]).not.toBe('#');
      expect(maze[17][x]).not.toBe('#');
    }
  });
});
