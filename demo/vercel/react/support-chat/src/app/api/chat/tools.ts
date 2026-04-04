/**
 * Tool definitions for the support chat demo.
 *
 * Server tools: lookupOrder, searchProducts, processReturn, getStoresNearLocation, getProductReviews
 * Client tool: getLocation (browser geolocation)
 * Orchestrator tool: planTasks (signals delegation to parallel sub-agents)
 *
 * getStoresNearLocation and getProductReviews use LLM calls (Haiku) to generate
 * realistic contextual mock data at runtime.
 */

import type { Tool } from 'ai';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

/** Always returns the same order — a pair of headphones out for delivery. */
function mockOrder(orderId: string) {
  const normalized = orderId.startsWith('#') ? orderId : `#${orderId}`;
  return {
    orderId: normalized,
    status: 'shipped',
    items: [
      { name: 'Wireless Noise-Cancelling Headphones', sku: 'WH-1000', price: 279.99, color: 'black' },
    ],
    tracking: 'USP-9283746510',
    carrier: 'UPS',
    eta: 'Today by 5pm',
    shippedAt: 'April 2, 2026',
    address: '123 Main St, San Francisco, CA 94102',
  };
}

const MOCK_PRODUCTS = [
  { name: 'Wireless Noise-Cancelling Headphones', sku: 'WH-1000', price: 279.99, colors: ['black', 'silver', 'blue'], rating: 4.7, reviews: 2341 },
  { name: 'Wireless Earbuds Pro', sku: 'WE-500', price: 199.99, colors: ['white', 'black'], rating: 4.5, reviews: 1892 },
  { name: 'Over-Ear Studio Headphones', sku: 'SH-300', price: 349.99, colors: ['black', 'red'], rating: 4.8, reviews: 567 },
  { name: 'Sport Bluetooth Earbuds', sku: 'SE-200', price: 89.99, colors: ['black', 'blue', 'green'], rating: 4.3, reviews: 3210 },
  { name: 'Ergonomic Keyboard', sku: 'KB-200', price: 149.99, colors: ['white', 'black'], rating: 4.6, reviews: 1105 },
  { name: 'Mechanical Gaming Keyboard', sku: 'KB-500', price: 199.99, colors: ['black', 'rgb'], rating: 4.4, reviews: 890 },
  { name: 'USB-C Hub 7-Port', sku: 'HUB-7P', price: 59.99, colors: ['silver', 'space gray'], rating: 4.2, reviews: 2100 },
  { name: 'Portable Bluetooth Speaker', sku: 'BS-100', price: 69.99, colors: ['blue', 'red', 'black'], rating: 4.1, reviews: 4500 },
];

const storeSchema = z.object({
  stores: z.array(z.object({
    name: z.string().describe('Store name, always starting with "Acme Electronics —" followed by a local landmark or neighborhood'),
    address: z.string().describe('A realistic street address in the area'),
    distance: z.string().describe('Distance from the search location, e.g. "1.2 mi" or "3.5 mi"'),
    hours: z.string().describe('Opening hours, e.g. "10am–8pm"'),
    phone: z.string().describe('A 555- phone number with the correct area code for the region'),
  })).describe('3 stores near the location, ordered by distance'),
});

// ---------------------------------------------------------------------------
// Server tools
// ---------------------------------------------------------------------------

export const tools: Record<string, Tool> = {
  lookupOrder: {
    description: 'Look up order details by order ID. Returns status, items, tracking info, and estimated delivery.',
    inputSchema: z.object({
      orderId: z.string().describe('The order ID, e.g. "#4821"'),
    }),
    execute: async ({ orderId }: { orderId: string }) => {
      await new Promise((r) => setTimeout(r, 800));
      return mockOrder(orderId);
    },
  },

  searchProducts: {
    description: 'Search the product catalog. Returns matching products with prices, colors, and ratings.',
    inputSchema: z.object({
      query: z.string().describe('Search query, e.g. "blue headphones" or "keyboard under $200"'),
    }),
    execute: async ({ query }: { query: string }) => {
      await new Promise((r) => setTimeout(r, 600));
      const q = query.toLowerCase();
      const results = MOCK_PRODUCTS.filter((p) => {
        const text = `${p.name} ${p.colors.join(' ')}`.toLowerCase();
        return q.split(' ').some((word) => text.includes(word));
      });
      return { query, results: results.length > 0 ? results : MOCK_PRODUCTS.slice(0, 3), totalResults: results.length };
    },
  },

  processReturn: {
    description: 'Initiate a return for an order. Checks eligibility and provides return instructions.',
    inputSchema: z.object({
      orderId: z.string().describe('The order ID to return'),
      reason: z.string().describe('Reason for the return'),
    }),
    execute: async ({ orderId, reason }: { orderId: string; reason: string }) => {
      await new Promise((r) => setTimeout(r, 1000));
      const normalized = orderId.startsWith('#') ? orderId : `#${orderId}`;
      return {
        returnId: `RET-${Date.now().toString(36).toUpperCase()}`,
        orderId: normalized,
        status: 'approved',
        reason,
        instructions: 'A prepaid shipping label has been sent to your email. Pack the item in its original packaging and drop it off at any UPS location.',
        refundEstimate: '5-7 business days after we receive the item',
      };
    },
  },

  getLocation: {
    description: `Get the user's current geographic location from their browser. Use this when the user asks about nearby stores or wants location-based results, and hasn't provided a specific location. Always pass highAccuracy: false.`,
    inputSchema: z.object({
      highAccuracy: z.boolean().describe('Whether to request high-accuracy GPS positioning. Always pass false.'),
    }),
    outputSchema: z.object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      error: z.string().optional(),
    }),
    // No execute — client-side tool
  },

  getStoresNearLocation: {
    description: 'Find Acme Electronics stores near a location. Pass either lat/lng coordinates (from getLocation) or a place name. Use getLocation first if the user says "near me" without specifying a place.',
    inputSchema: z.object({
      latitude: z.number().optional().describe('Latitude from getLocation result'),
      longitude: z.number().optional().describe('Longitude from getLocation result'),
      location: z.string().optional().describe('A place name, e.g. "Portland, OR" or "downtown Seattle"'),
    }),
    execute: async ({ latitude, longitude, location }: { latitude?: number; longitude?: number; location?: string }) => {
      const label = location ?? (latitude && longitude ? `${latitude.toFixed(2)}, ${longitude.toFixed(2)}` : 'your area');
      const locationHint = location
        ? `the user searched for "${location}"`
        : latitude && longitude
          ? `coordinates ${latitude.toFixed(4)}, ${longitude.toFixed(4)} — infer the city/region from these coordinates`
          : 'an unknown area';

      const { object } = await generateObject({
        model: anthropic('claude-3-haiku-20240307'),
        schema: storeSchema,
        prompt: `Generate 3 fictional Acme Electronics store locations near ${locationHint}. Use realistic street addresses, landmarks, and area codes for that region. Distances should be 0.5–6 miles.`,
      });

      return { location: label, stores: object.stores };
    },
  },

  processRefund: {
    description: 'Process a confirmed refund for a return. Only call this after the customer has accepted the refund.',
    inputSchema: z.object({
      returnId: z.string().describe('The return ID'),
      orderId: z.string().describe('The order ID'),
      amount: z.number().describe('Refund amount'),
    }),
    execute: async ({ returnId, orderId, amount }: { returnId: string; orderId: string; amount: number }) => {
      await new Promise((r) => setTimeout(r, 1000));
      return {
        refundId: `REF-${Date.now().toString(36).toUpperCase()}`,
        returnId,
        orderId,
        amount,
        status: 'processed',
        method: 'Original payment method',
        eta: '3-5 business days',
      };
    },
  },

  cancelReturn: {
    description: 'Cancel a return that is in progress. Use when the customer changes their mind and wants to keep the item.',
    inputSchema: z.object({
      returnId: z.string().describe('The return ID to cancel'),
      orderId: z.string().describe('The order ID'),
    }),
    execute: async ({ returnId, orderId }: { returnId: string; orderId: string }) => {
      await new Promise((r) => setTimeout(r, 800));
      return {
        returnId,
        orderId,
        status: 'cancelled',
        message: 'Return has been cancelled. You can keep your item — no further action needed.',
      };
    },
  },

  getReviews: {
    description: 'Get customer reviews for a product. Streams 3 distinct review messages back to the user.',
    inputSchema: z.object({
      sku: z.string().describe('Product SKU, e.g. "WH-1000"'),
      productName: z.string().describe('Product name for display'),
    }),
    execute: async ({ sku, productName }: { sku: string; productName: string }) => {
      return { sku, productName, delegated: true };
    },
  },

  purchaseProduct: {
    description: 'Purchase a product for the customer. Runs the full order workflow — checks stock, processes payment, and confirms the order.',
    inputSchema: z.object({
      sku: z.string().describe('Product SKU to purchase'),
      productName: z.string().describe('Product name for display'),
    }),
    execute: async ({ sku, productName }: { sku: string; productName: string }) => {
      return { sku, productName, delegated: true };
    },
  },

  processReturnWorkflow: {
    description: 'Run the full return process for an order — looks up the order, checks eligibility, processes the return, and sends confirmation. Use this instead of processReturn when the user asks to return an order.',
    inputSchema: z.object({
      orderId: z.string().describe('The order ID to return, e.g. "#4821"'),
      reason: z.string().describe('Reason for the return'),
    }),
    execute: async ({ orderId, reason }: { orderId: string; reason: string }) => {
      return { orderId, reason, streaming: true };
    },
  },

  productResearch: {
    description: 'Run a thorough product research workflow — searches the catalog, compares specs, analyzes reviews, checks stock, and provides a recommendation. Use this when the user wants product recommendations or is browsing.',
    inputSchema: z.object({
      query: z.string().describe('What the user is looking for, e.g. "replacement headphones" or "budget keyboard"'),
    }),
    execute: async ({ query }: { query: string }) => {
      return { query, streaming: true };
    },
  },

  escalateToHuman: {
    description: 'Escalate the conversation to a human support agent. Use when the customer explicitly asks to speak to a human or when you cannot resolve their issue.',
    inputSchema: z.object({
      reason: z.string().describe('Brief reason for escalation'),
    }),
    execute: async ({ reason }: { reason: string }) => {
      return { escalated: true, reason };
    },
  },
};

// ---------------------------------------------------------------------------
// Orchestrator-only tool: planTasks
// ---------------------------------------------------------------------------

export const planTasksTool: Tool = {
  description: `When the user's request involves multiple independent tasks that can be handled in parallel, call this tool to plan the delegation. For example, if the user wants to return an order AND find a replacement, those are two independent tasks. Do NOT call this for simple single-task requests.`,
  inputSchema: z.object({
    tasks: z.array(z.object({
      agentId: z.string().describe('A short identifier for the sub-agent, e.g. "returns-agent" or "research-agent"'),
      agentLabel: z.string().describe('A human-readable label for this agent, e.g. "Returns Agent" or "Product Research"'),
      task: z.string().describe('A clear description of what this sub-agent should do'),
      tools: z.array(z.string()).describe('Which tools this agent needs: "lookupOrder", "searchProducts", "processReturn", "getLocation"'),
    })).describe('The list of independent tasks to delegate to parallel sub-agents'),
    summary: z.string().describe('A brief message to show the user while the agents work, e.g. "I\'ll handle both tasks simultaneously..."'),
  }),
  execute: async (input: { tasks: Array<{ agentId: string; agentLabel: string; task: string; tools: string[] }>; summary: string }) => {
    // This tool just returns the plan — the route handler spawns the actual sub-agents
    return { delegated: true, taskCount: input.tasks.length };
  },
};

/** Subset of tools available to sub-agents (excludes planTasks). */
export function getToolsForAgent(toolNames: string[]): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const name of toolNames) {
    if (name in tools) {
      result[name] = tools[name];
    }
  }
  return result;
}
