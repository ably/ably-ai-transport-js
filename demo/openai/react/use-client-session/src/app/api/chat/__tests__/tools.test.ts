import { describe, it, expect } from 'vitest';

import { executeTool, isClientTool, needsApproval, type ForecastData, type WeatherData } from '../tools';

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

  it('runs getWeatherForecast and returns a populated ForecastData payload', () => {
    const out = executeTool('getWeatherForecast', '{"location":"Paris, FR"}') as ForecastData;
    expect(out.location).toBe('Paris, FR');
    expect(out.forecast).toHaveLength(5);
    for (const day of out.forecast) {
      expect(typeof day.day).toBe('string');
      expect(typeof day.high).toBe('number');
      expect(typeof day.low).toBe('number');
      expect(typeof day.conditions).toBe('string');
    }
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
    expect(() => executeTool('nope', '{}')).toThrow('unknown or non-server tool: nope');
  });

  it('throws for a client-executed tool the agent does not run server-side', () => {
    expect(() => executeTool('getLocation', '{}')).toThrow('unknown or non-server tool: getLocation');
  });
});

describe('isClientTool', () => {
  it('is true only for client-executed tools', () => {
    expect(isClientTool('getLocation')).toBe(true);
    expect(isClientTool('getWeather')).toBe(false);
    expect(isClientTool('getWeatherForecast')).toBe(false);
  });
});

describe('needsApproval', () => {
  it('is true only for approval-gated tools', () => {
    expect(needsApproval('getWeatherForecast')).toBe(true);
    expect(needsApproval('getWeather')).toBe(false);
    expect(needsApproval('getLocation')).toBe(false);
  });
});
