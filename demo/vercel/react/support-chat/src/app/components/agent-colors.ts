/** Agent display config — shared across header, message bubble, and progress card. */

export interface AgentStyle {
  label: string;
  /** Tailwind classes for the pill/badge background + text. */
  pill: string;
  /** Tailwind class for the progress bar fill. */
  progressBar: string;
  /** Tailwind class for the card border when streaming. */
  border: string;
  /** Tailwind class for the status icon when done. */
  doneBg: string;
  doneIcon: string;
  /** Tailwind class for the spinner border. */
  spinnerBorder: string;
  spinnerTick: string;
}

export const AGENT_STYLES: Record<string, AgentStyle> = {
  'returns-agent': {
    label: 'Returns',
    pill: 'bg-violet-950/60 text-violet-400 border-violet-800/40',
    progressBar: 'bg-violet-500/60',
    border: 'border-violet-800/30',
    doneBg: 'bg-violet-500/20',
    doneIcon: 'text-violet-400',
    spinnerBorder: 'border-violet-500/60',
    spinnerTick: 'border-t-violet-400',
  },
  'research-agent': {
    label: 'Product Research',
    pill: 'bg-cyan-950/60 text-cyan-400 border-cyan-800/40',
    progressBar: 'bg-cyan-500/60',
    border: 'border-cyan-800/30',
    doneBg: 'bg-cyan-500/20',
    doneIcon: 'text-cyan-400',
    spinnerBorder: 'border-cyan-500/60',
    spinnerTick: 'border-t-cyan-400',
  },
  'orders-agent': {
    label: 'Order',
    pill: 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40',
    progressBar: 'bg-emerald-500/60',
    border: 'border-emerald-800/30',
    doneBg: 'bg-emerald-500/20',
    doneIcon: 'text-emerald-400',
    spinnerBorder: 'border-emerald-500/60',
    spinnerTick: 'border-t-emerald-400',
  },
};

/** Fallback style for unknown agents. */
const DEFAULT_STYLE: AgentStyle = {
  label: 'Agent',
  pill: 'bg-zinc-900 text-zinc-400 border-zinc-700',
  progressBar: 'bg-zinc-500/60',
  border: 'border-zinc-700',
  doneBg: 'bg-emerald-500/20',
  doneIcon: 'text-emerald-400',
  spinnerBorder: 'border-amber-500/60',
  spinnerTick: 'border-t-amber-400',
};

export function getAgentStyle(clientId: string): AgentStyle {
  return AGENT_STYLES[clientId] ?? DEFAULT_STYLE;
}

export function isKnownAgent(clientId: string | undefined): clientId is string {
  return clientId !== undefined && clientId in AGENT_STYLES;
}
