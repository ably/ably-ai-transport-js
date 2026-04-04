'use client';

import type { DynamicToolUIPart } from 'ai';

// ---------------------------------------------------------------------------
// Order card
// ---------------------------------------------------------------------------

interface OrderData {
  orderId: string;
  status: string;
  items: Array<{ name: string; sku: string; price: number; color: string }>;
  tracking: string | null;
  carrier: string | null;
  eta: string | null;
  shippedAt: string | null;
  address: string;
}

function OrderCard({ data }: { data: OrderData }) {
  const statusColors: Record<string, string> = {
    shipped: 'text-emerald-400 bg-emerald-950',
    processing: 'text-amber-400 bg-amber-950',
    delivered: 'text-blue-400 bg-blue-950',
  };
  const statusClass = statusColors[data.status] ?? 'text-zinc-400 bg-zinc-900';

  return (
    <div className="rounded-lg bg-gradient-to-br from-zinc-800/60 to-zinc-900/60 border border-zinc-700/40 p-3 my-1 max-w-[340px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-300">Order {data.orderId}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusClass}`}>
          {data.status}
        </span>
      </div>
      {data.items.map((item, i) => (
        <div key={i} className="text-xs text-zinc-400 mb-1">
          {item.name} <span className="text-zinc-600">({item.color})</span>
          <span className="text-zinc-500 ml-1">${item.price}</span>
        </div>
      ))}
      {data.tracking && (
        <div className="mt-2 text-[11px] text-zinc-500">
          <span className="text-zinc-600">Tracking:</span> {data.carrier} {data.tracking}
        </div>
      )}
      {data.eta && (
        <div className="text-[11px] text-zinc-500">
          <span className="text-zinc-600">ETA:</span> {data.eta}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product results
// ---------------------------------------------------------------------------

interface ProductData {
  name: string;
  sku: string;
  price: number;
  colors: string[];
  rating: number;
  reviews: number;
}

function ProductResults({ results }: { results: ProductData[] }) {
  return (
    <div className="space-y-1.5 my-1">
      {results.map((p) => (
        <div key={p.sku} className="rounded-lg bg-zinc-800/50 border border-zinc-700/30 p-2.5 max-w-[340px]">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-zinc-300">{p.name}</div>
            <div className="text-xs font-medium text-zinc-200 shrink-0">${p.price}</div>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
            <span>{p.rating} stars ({p.reviews} reviews)</span>
            <span>{p.colors.join(', ')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order confirmation
// ---------------------------------------------------------------------------

interface OrderConfirmationData {
  orderId: string;
  productName: string;
  status: string;
  eta: string;
  tracking: string;
  carrier: string;
}

function OrderConfirmation({ data }: { data: OrderConfirmationData }) {
  return (
    <div className="rounded-lg bg-gradient-to-br from-emerald-950/30 to-zinc-900/60 border border-emerald-800/30 p-3 my-1 max-w-[340px]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-emerald-400">Order Confirmed</span>
        <span className="text-[10px] text-zinc-500">{data.orderId}</span>
      </div>
      <div className="text-xs text-zinc-300 mb-1">{data.productName}</div>
      <div className="text-[11px] text-zinc-500">
        <span className="text-zinc-600">Tracking:</span> {data.carrier} {data.tracking}
      </div>
      <div className="text-[11px] text-zinc-500">
        <span className="text-zinc-600">ETA:</span> {data.eta}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Return confirmation
// ---------------------------------------------------------------------------

interface ReturnData {
  returnId: string;
  orderId: string;
  status: string;
  instructions: string;
  refundEstimate: string;
}

function ReturnCard({ data }: { data: ReturnData }) {
  return (
    <div className="rounded-lg bg-gradient-to-br from-emerald-950/30 to-zinc-900/60 border border-emerald-800/30 p-3 my-1 max-w-[340px]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-emerald-400">Return Approved</span>
        <span className="text-[10px] text-zinc-500">{data.returnId}</span>
      </div>
      <div className="text-xs text-zinc-400 mb-1">{data.instructions}</div>
      <div className="text-[11px] text-zinc-500">
        <span className="text-zinc-600">Refund:</span> {data.refundEstimate}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Store results
// ---------------------------------------------------------------------------

interface StoreData {
  name: string;
  address: string;
  distance: string;
  hours: string;
  phone: string;
}

function StoreResults({ stores, location }: { stores: StoreData[]; location: string }) {
  return (
    <div className="my-1">
      <div className="text-[11px] text-zinc-500 mb-1.5">Stores near {location}</div>
      <div className="space-y-1.5">
        {stores.map((s, i) => (
          <div key={i} className="rounded-lg bg-zinc-800/50 border border-zinc-700/30 p-2.5 max-w-[340px]">
            <div className="text-xs font-medium text-zinc-300">{s.name}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">{s.address}</div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
              <span className="text-emerald-400/80">{s.distance}</span>
              <span>{s.hours}</span>
              <span>{s.phone}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Location display
// ---------------------------------------------------------------------------

function LocationResult({ output }: { output: unknown }) {
  const data = output as { latitude?: number; longitude?: number; error?: string } | undefined;
  if (!data) return null;
  if (data.error) {
    return (
      <div className="rounded-md bg-red-950/30 border border-red-900/30 px-2.5 py-1.5 text-xs text-red-400 my-1">
        Location error: {data.error}
      </div>
    );
  }
  return (
    <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
      Location: {data.latitude?.toFixed(4)}, {data.longitude?.toFixed(4)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic states
// ---------------------------------------------------------------------------

function ToolPending({ name, input }: { name: string; input: unknown }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 my-1 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-500/60 animate-pulse" />
      <span className="text-zinc-400">
        Calling <span className="font-mono text-zinc-300">{name}</span>
        {input != null && Object.keys(input as object).length > 0 && (
          <span className="text-zinc-500 ml-1">({JSON.stringify(input)})</span>
        )}
      </span>
    </div>
  );
}

function ToolError({ name, errorText }: { name: string; errorText: string }) {
  return (
    <div className="rounded-md bg-red-950/30 border border-red-900/30 px-2.5 py-1.5 text-xs my-1">
      <span className="text-red-400">
        <span className="font-mono">{name}</span> failed: {errorText}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/** Delegate tools that render nothing in all states — they spawn sub-agents or separate turns. */
const SILENT_TOOLS = new Set([
  'getReviews',
  'purchaseProduct',
  'processReturnWorkflow',
  'productResearch',
  'planTasks',
]);

export function ToolInvocation({ part }: { part: DynamicToolUIPart }) {
  // Delegate tools never render — sub-agents handle the UI
  if (SILENT_TOOLS.has(part.toolName)) return null;

  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return <ToolPending name={part.toolName} input={part.input} />;

    case 'output-available': {
      if (part.toolName === 'lookupOrder') {
        const data = part.output as OrderData | { error: string };
        if ('error' in data) {
          return <ToolError name={part.toolName} errorText={data.error} />;
        }
        return <OrderCard data={data} />;
      }
      if (part.toolName === 'searchProducts') {
        const data = part.output as { results: ProductData[] };
        return <ProductResults results={data.results} />;
      }
      if (part.toolName === 'cancelReturn') {
        const data = part.output as { returnId: string; status: string; message: string };
        return (
          <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
            <span className="text-zinc-300 font-medium">Return {data.returnId} cancelled</span> — {data.message}
          </div>
        );
      }
      if (part.toolName === 'processRefund') {
        const data = part.output as { refundId: string; amount: number; method: string; eta: string };
        return (
          <div className="rounded-lg bg-gradient-to-br from-emerald-950/30 to-zinc-900/60 border border-emerald-800/30 p-3 my-1 max-w-[340px]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-emerald-400">Refund Processed</span>
              <span className="text-[10px] text-zinc-500">{data.refundId}</span>
            </div>
            <div className="text-xs text-zinc-400 mb-1">${data.amount.toFixed(2)} → {data.method}</div>
            <div className="text-[11px] text-zinc-500">
              <span className="text-zinc-600">Expected:</span> {data.eta}
            </div>
          </div>
        );
      }
      if (part.toolName === 'createOrder') {
        return <OrderConfirmation data={part.output as OrderConfirmationData} />;
      }
      if (part.toolName === 'processReturn') {
        return <ReturnCard data={part.output as ReturnData} />;
      }
      if (part.toolName === 'getStoresNearLocation') {
        const data = part.output as { stores: StoreData[]; location: string };
        return <StoreResults stores={data.stores} location={data.location} />;
      }
      if (part.toolName === 'getLocation') {
        return <LocationResult output={part.output} />;
      }
      if (part.toolName === 'escalateToHuman') {
        return (
          <div className="rounded-lg bg-amber-950/20 border border-amber-800/30 p-3 my-1.5 max-w-[340px]">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-amber-400 text-sm">🔄</span>
              <span className="text-xs font-medium text-amber-400">Transferring to human agent</span>
            </div>
            <div className="text-[11px] text-zinc-400">A support agent will join the conversation shortly. You can continue chatting once they connect.</div>
          </div>
        );
      }
      // Generic fallback
      return (
        <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
          <span className="font-mono">{part.toolName}</span>: {JSON.stringify(part.output)}
        </div>
      );
    }

    case 'output-error':
      return <ToolError name={part.toolName} errorText={part.errorText} />;

    case 'approval-requested':
      return <ToolPending name={part.toolName} input={part.input} />;

    default:
      return null;
  }
}
