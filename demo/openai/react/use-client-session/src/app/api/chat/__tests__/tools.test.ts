import { describe, it, expect } from 'vitest';

import { executeTool, type WeatherData } from '../tools';

describe('executeTool', () => {
  it('runs getWeather and returns a populated WeatherData payload', () => {
    const out = executeTool('getWeather', '{"location":"London, UK"}') as WeatherData;
    expect(out.location).toBe('London, UK');
    expect(typeof out.temperature).toBe('number');
    expect(out.unit).toBe('fahrenheit');
    expect(typeof out.conditions).toBe('string');
    expect(typeof out.humidity).toBe('number');
    expect(typeof out.windSpeed).toBe('number');
  });

  it('falls back to a default location when the arguments are not valid JSON', () => {
    const out = executeTool('getWeather', 'not json') as WeatherData;
    expect(out.location).toBe('your location');
  });

  it('falls back to a default location when the location argument is missing', () => {
    const out = executeTool('getWeather', '{}') as WeatherData;
    expect(out.location).toBe('your location');
  });

  it('throws for an unknown tool', () => {
    expect(() => executeTool('nope', '{}')).toThrow('unknown tool: nope');
  });
});
