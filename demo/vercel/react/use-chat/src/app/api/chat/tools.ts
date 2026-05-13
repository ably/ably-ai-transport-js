/**
 * Tool definitions for the chat demo.
 *
 * - getWeather: server-executed, returns mock weather data
 * - getLocation: client-executed, no execute function — the client
 *   runs browser geolocation and sends the result back via view.update()
 * - getWeatherForecast: server-executed but gated on user approval
 *   (needsApproval: true). The client sees an approval-requested tool
 *   part; after addToolApprovalResponse, the server runs execute() and
 *   the result is stitched back onto the original assistant message.
 * - generateImage: server-executed. Calls Vercel AI SDK generateImage,
 *   downscales the result to a small WebP, and publishes it as a fresh
 *   assistant message via `run.pipe` so the image lands on the channel
 *   as a `file` UIMessagePart. Returns a small ack to the LLM so it can
 *   summarise textually.
 * - generateSpeech: server-executed. Calls Vercel AI SDK
 *   `experimental_generateSpeech` (OpenAI tts-1) and publishes the resulting
 *   MP3 as a fresh assistant message via `run.pipe` so the audio lands on
 *   the channel as an audio `file` UIMessagePart. The tool caps text length
 *   to keep the data URL comfortably under the 64 KiB Ably message size cap.
 */

import type { Run } from '@ably/ai-transport';
import { openai } from '@ai-sdk/openai';
import { createUIMessageStream, experimental_generateSpeech, generateImage } from 'ai';
import type { Tool, UIMessage, UIMessageChunk } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';

const weatherInput = z.object({
  location: z.string().describe('The city and state or country, e.g. "San Francisco, CA"'),
});

const locationOutput = z.object({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  error: z.string().optional(),
});

interface CreateToolsOptions {
  run: Run<UIMessageChunk, UIMessage>;
}

export const createTools = ({ run }: CreateToolsOptions): Record<string, Tool> => ({
  getWeather: {
    description: 'Get the current weather for a location. Call this when the user asks about weather.',
    inputSchema: weatherInput,
    execute: async ({ location }: { location: string }) => {
      // Simulate a weather API call
      await new Promise((r) => setTimeout(r, 500));
      const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms', 'Snowy'] as const;
      return {
        location,
        temperature: Math.round(50 + Math.random() * 40),
        unit: 'fahrenheit' as const,
        conditions: conditions[Math.floor(Math.random() * conditions.length)],
        humidity: Math.round(30 + Math.random() * 50),
        windSpeed: Math.round(5 + Math.random() * 20),
      };
    },
  },

  getLocation: {
    description: `Get the user's current geographic location from their browser. Call this when the user doesn't specify a location, then call getWeather with the result.`,
    inputSchema: z.object({
      highAccuracy: z.boolean().describe('Whether to request high-accuracy GPS positioning'),
    }),
    // No execute — client-side tool. The client runs navigator.geolocation
    // and sends the result via view.update().
    outputSchema: locationOutput,
  },

  getWeatherForecast: {
    description:
      'Get a 5-day weather forecast for a location. Requires user approval before executing. Use when the user asks about upcoming weather or a forecast.',
    needsApproval: true as const,
    inputSchema: z.object({
      location: z.string().describe('The city and state or country, e.g. "London, UK"'),
    }),
    execute: async ({ location }: { location: string }) => {
      await new Promise((r) => setTimeout(r, 500));
      const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms'] as const;
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      return {
        location,
        forecast: days.map((day) => ({
          day,
          high: Math.round(55 + Math.random() * 35),
          low: Math.round(35 + Math.random() * 25),
          conditions: conditions[Math.floor(Math.random() * conditions.length)],
        })),
      };
    },
  },

  generateImage: {
    description:
      'Generate an icon, logo, or small thumbnail image from a text prompt. The result is a 256x256 WebP that ships over Ably as a file UIMessagePart on its own assistant message.',
    inputSchema: z.object({
      prompt: z.string().describe('What the image should depict, in natural language.'),
    }),
    execute: async ({ prompt }: { prompt: string }) => {
      const { image } = await generateImage({
        model: openai.image('gpt-image-1'),
        prompt,
        size: '1024x1024',
      });
      // Downscale to a small WebP so the resulting data URL fits under the
      // 64 KiB Ably message size cap (gpt-image-1's smallest native output
      // is 1024x1024).
      const webp = await sharp(image.uint8Array).resize(256, 256, { fit: 'cover' }).webp({ quality: 70 }).toBuffer();
      const url = `data:image/webp;base64,${webp.toString('base64')}`;

      const fileStream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'start' });
          writer.write({ type: 'file', mediaType: 'image/webp', url });
          writer.write({ type: 'finish', finishReason: 'stop' });
        },
      });
      await run.pipe(fileStream);

      return { ok: true, mediaType: 'image/webp', sizeBytes: webp.byteLength };
    },
  },

  generateSpeech: {
    description:
      'Generate a short spoken-audio response from a text prompt. The result ships over Ably as an audio file UIMessagePart on its own assistant message. Keep the text under ~25 words to fit the 64 KiB message size cap.',
    inputSchema: z.object({
      text: z.string().max(200).describe('What to say, up to 200 characters.'),
      voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).optional(),
    }),
    execute: async ({ text, voice }: { text: string; voice?: string }) => {
      const { audio } = await experimental_generateSpeech({
        model: openai.speech('tts-1'),
        text,
        voice: voice ?? 'alloy',
      });
      const url = `data:${audio.mediaType};base64,${audio.base64}`;

      const fileStream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'start' });
          writer.write({ type: 'file', mediaType: audio.mediaType, url });
          writer.write({ type: 'finish', finishReason: 'stop' });
        },
      });
      await run.pipe(fileStream);

      return { ok: true, mediaType: audio.mediaType, sizeBytes: audio.uint8Array.byteLength };
    },
  },
});
