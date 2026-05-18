/**
 * SpeechPresets - preset prompt chips for the Speech tab.
 *
 * Each chip fills the input with a prompt that nudges the assistant to call
 * the `generateSpeech` tool. The audio arrives over Ably as a `file`
 * UIMessagePart on a fresh assistant message and renders inline as an
 * <audio> player in the chat.
 */

interface SpeechPreset {
  id: string;
  label: string;
  prompt: string;
}

const PRESETS: SpeechPreset[] = [
  {
    id: 'welcome',
    label: 'welcome announcement',
    prompt: 'Say "Hello, welcome to Ably AI Transport" out loud.',
  },
  {
    id: 'build-done',
    label: 'build notification',
    prompt: 'Read aloud: "Your build has finished successfully."',
  },
  {
    id: 'meeting-warning',
    label: 'meeting reminder',
    prompt: 'Speak this message: "Meeting starts in five minutes."',
  },
];

interface SpeechPresetsProps {
  onSelectPrompt: (prompt: string) => void;
}

export function SpeechPresets({ onSelectPrompt }: SpeechPresetsProps) {
  return (
    <div className="chip-scrollbar flex max-h-[60px] flex-wrap items-start gap-1.5 overflow-y-auto px-4 pt-3">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onSelectPrompt(preset.prompt)}
          className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
        >
          <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Speech</span>
          {preset.label}
        </button>
      ))}
    </div>
  );
}
