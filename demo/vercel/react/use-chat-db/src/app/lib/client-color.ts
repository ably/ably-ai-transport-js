/**
 * Maps a clientId to a stable colour from a fixed palette so multiple clients
 * on the same channel can be told apart in the UI. Hash → palette index.
 *
 * `userBubble` targets the shadcn Bubble's content slot (the element its
 * variants paint), so the class must carry the same `*:data-[slot=…]` prefix
 * for the variant's own background to be overridden.
 */

interface ClientColor {
  text: string;
  userBubble: string;
  avatarBg: string;
}

const PALETTE: ClientColor[] = [
  {
    text: 'text-emerald-300',
    userBubble: '*:data-[slot=bubble-content]:bg-emerald-900/40',
    avatarBg: 'bg-emerald-600',
  },
  { text: 'text-teal-300', userBubble: '*:data-[slot=bubble-content]:bg-teal-900/40', avatarBg: 'bg-teal-600' },
  { text: 'text-cyan-300', userBubble: '*:data-[slot=bubble-content]:bg-cyan-900/40', avatarBg: 'bg-cyan-600' },
  { text: 'text-sky-300', userBubble: '*:data-[slot=bubble-content]:bg-sky-900/40', avatarBg: 'bg-sky-600' },
  { text: 'text-indigo-300', userBubble: '*:data-[slot=bubble-content]:bg-indigo-900/40', avatarBg: 'bg-indigo-600' },
  { text: 'text-violet-300', userBubble: '*:data-[slot=bubble-content]:bg-violet-900/40', avatarBg: 'bg-violet-600' },
  {
    text: 'text-fuchsia-300',
    userBubble: '*:data-[slot=bubble-content]:bg-fuchsia-900/40',
    avatarBg: 'bg-fuchsia-600',
  },
  { text: 'text-pink-300', userBubble: '*:data-[slot=bubble-content]:bg-pink-900/40', avatarBg: 'bg-pink-600' },
  { text: 'text-rose-300', userBubble: '*:data-[slot=bubble-content]:bg-rose-900/40', avatarBg: 'bg-rose-600' },
  { text: 'text-red-300', userBubble: '*:data-[slot=bubble-content]:bg-red-900/40', avatarBg: 'bg-red-600' },
  { text: 'text-orange-300', userBubble: '*:data-[slot=bubble-content]:bg-orange-900/40', avatarBg: 'bg-orange-600' },
  { text: 'text-amber-300', userBubble: '*:data-[slot=bubble-content]:bg-amber-900/40', avatarBg: 'bg-amber-600' },
  { text: 'text-yellow-300', userBubble: '*:data-[slot=bubble-content]:bg-yellow-900/40', avatarBg: 'bg-yellow-600' },
  { text: 'text-lime-300', userBubble: '*:data-[slot=bubble-content]:bg-lime-900/40', avatarBg: 'bg-lime-600' },
];

function hashClientId(clientId: string): number {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function clientColor(clientId: string): ClientColor {
  return PALETTE[hashClientId(clientId) % PALETTE.length];
}
