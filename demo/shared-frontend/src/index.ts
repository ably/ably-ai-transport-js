// Providers + hooks context
export { Providers, useAblyReady, SessionHooks } from './providers';

// Components
export { Chat } from './components/chat';
export { MessageList } from './components/message-list';
export { MessageBubble } from './components/message-bubble';
export { AvatarStack } from './components/avatar-stack';
export { SuggestionChips } from './components/suggestion-chips';
export { ToolInvocation } from './components/tool-invocation';
export { DebugPane } from './components/debug-pane';
export type { ClientToolLogEntry, LifecycleLogEntry } from './components/debug-pane';
export { IntroCard, COMMON_DEMO_STEPS } from './components/intro-card';
export type { DemoStep } from './components/intro-card';

// Hooks
export { useClientTools } from './hooks/use-client-tools';
export { useDemoProgress } from './hooks/use-demo-progress';
export type { PromptDemoStep, GestureDemoStep, DemoStepId, DemoStep as ProgressStep } from './hooks/use-demo-progress';

// Utilities
export { generateChannelSlug, generateClientName } from './lib/channel-name';
export { clientColor } from './lib/client-color';
export { userMessage, wakeAgent } from './helpers';
