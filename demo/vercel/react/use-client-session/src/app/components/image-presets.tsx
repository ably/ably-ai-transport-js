/**
 * ImagePresets - preset prompt chips for the Images tab.
 *
 * Each chip sends a prompt directly via `view.send`, nudging the assistant
 * to call the `generateImage` tool. The image arrives over Ably as a `file`
 * UIMessagePart on a fresh assistant message and renders inline.
 */

interface ImagePreset {
  id: string;
  label: string;
  prompt: string;
}

const PRESETS: ImagePreset[] = [
  {
    id: 'favicon-coffee',
    label: 'favicon for a coffee shop',
    prompt: 'Generate a favicon for a coffee shop - round logo, warm colors, simple silhouette.',
  },
  {
    id: 'logo-music',
    label: 'logo for a music app',
    prompt: 'Generate a small logo for a music streaming app - minimalist, geometric, vibrant.',
  },
  {
    id: 'icon-mountain',
    label: 'minimalist mountain icon',
    prompt: 'Generate a minimalist mountain icon - flat colors, clean lines, suitable for a hiking app.',
  },
];

interface ImagePresetsProps {
  onSelectPrompt: (prompt: string) => void;
}

export function ImagePresets({ onSelectPrompt }: ImagePresetsProps) {
  return (
    <div className="flex max-h-[60px] flex-wrap items-start gap-1.5 overflow-y-auto border-t border-zinc-800 px-4 pt-3">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onSelectPrompt(preset.prompt)}
          className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
        >
          <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Image</span>
          {preset.label}
        </button>
      ))}
    </div>
  );
}
