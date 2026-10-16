import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../vite.config';

afterEach(() => vi.unstubAllEnvs());
describe('API origin configuration', () => {
  it.each(['http://localhost:8080/?', 'http://localhost:8080/#'])('rejects empty URL delimiters in %s', baseUrl => {
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);
    expect(() => config({ command: 'build', mode: 'production' })).toThrow('HTTP(S) origin');
  });
  it.each(['http://localhost:8080', 'https://api.example.com/'])('accepts the origin %s', baseUrl => {
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);
    expect(() => config({ command: 'build', mode: 'production' })).not.toThrow();
  });
});
