import 'dotenv/config'
import { runAgentTask, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
// import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import { modelClient } from './config/model-client.js';

const config = loadDriftWatchConfigFromEnv();

// Tools the agent can call. Both hit Open-Meteo's free, keyless API — https://open-meteo.com.
const tools = {
  get_weather: tool({
    description: 'Get current weather for a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      );
      const geoData = await geoRes.json();
      const location = geoData.results?.[0];
      if (!location) {
        return { error: `No location found for "${city}"` };
      }

      const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current_weather=true`,
      );
      const weatherData = await weatherRes.json();
      return {
        city: location.name,
        country: location.country,
        tempC: weatherData.current_weather?.temperature,
        windSpeedKmh: weatherData.current_weather?.windspeed,
      };
    },
  }),

  search_docs: tool({
    description: 'Search the Open-Meteo API documentation for a query term',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const res = await fetch('https://open-meteo.com/en/docs');
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, ' ');
      const hits = text.split(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).length - 1;
      return { query, hits };
    },
  }),
};

const result = await runAgentTask({
  prompt: 'What is the weather in Lagos, and how many times does the Open-Meteo docs page mention "temperature"?',
  modelClient, // any AI SDK provider; needs its API key
  tools,
  maxSteps: config.agent.maxSteps,
});

console.log(result.responseText);
console.log(result.skillsUsed, result.tokenUsage);