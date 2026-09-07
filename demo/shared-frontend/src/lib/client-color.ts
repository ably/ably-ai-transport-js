/**
 * Maps a clientId to a stable colour from a fixed palette so multiple clients
 * on the same channel can be told apart in the UI. Hash → palette index.
 *
 * `primary` is the hue as an oklch colour (Tailwind's 500 shade). A bubble
 * sets it as its local `--primary`, and shadcn's `tinted` Bubble variant
 * derives the client-tinted background from that variable.
 */

interface ClientColor {
  text: string;
  primary: string;
  avatarBg: string;
}

const PALETTE: ClientColor[] = [
  { text: 'text-emerald-300', primary: 'oklch(69.6% 0.17 162.48)', avatarBg: 'bg-emerald-600' },
  { text: 'text-teal-300', primary: 'oklch(70.4% 0.14 182.503)', avatarBg: 'bg-teal-600' },
  { text: 'text-cyan-300', primary: 'oklch(71.5% 0.143 215.221)', avatarBg: 'bg-cyan-600' },
  { text: 'text-sky-300', primary: 'oklch(68.5% 0.169 237.323)', avatarBg: 'bg-sky-600' },
  { text: 'text-indigo-300', primary: 'oklch(58.5% 0.233 277.117)', avatarBg: 'bg-indigo-600' },
  { text: 'text-violet-300', primary: 'oklch(60.6% 0.25 292.717)', avatarBg: 'bg-violet-600' },
  { text: 'text-fuchsia-300', primary: 'oklch(66.7% 0.295 322.15)', avatarBg: 'bg-fuchsia-600' },
  { text: 'text-pink-300', primary: 'oklch(65.6% 0.241 354.308)', avatarBg: 'bg-pink-600' },
  { text: 'text-rose-300', primary: 'oklch(64.5% 0.246 16.439)', avatarBg: 'bg-rose-600' },
  { text: 'text-red-300', primary: 'oklch(63.7% 0.237 25.331)', avatarBg: 'bg-red-600' },
  { text: 'text-orange-300', primary: 'oklch(70.5% 0.213 47.604)', avatarBg: 'bg-orange-600' },
  { text: 'text-amber-300', primary: 'oklch(76.9% 0.188 70.08)', avatarBg: 'bg-amber-600' },
  { text: 'text-yellow-300', primary: 'oklch(79.5% 0.184 86.047)', avatarBg: 'bg-yellow-600' },
  { text: 'text-lime-300', primary: 'oklch(76.8% 0.233 130.85)', avatarBg: 'bg-lime-600' },
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
