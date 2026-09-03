// Providers
export { Providers, useAblyReady } from './ably-provider';
export { ThemeProvider } from './theme-provider';

// Theme selector
export { ThemeToggle } from './components/theme-toggle';

// Chat container + presentational shell
export { Chat } from './components/chat';
export type { ChatProps } from './components/chat';
export { ChatShell } from './components/chat-shell';
export type { HeaderLink } from './components/chat-shell';

// Transcript + components
export { LinearMessageList } from './components/message-list';
export { MessageBubble } from './components/message-bubble';
export type { MessageStatus } from './components/message-bubble';
export { AvatarStack } from './components/avatar-stack';
export { SuggestionChips } from './components/suggestion-chips';
export { ToolInvocation } from './components/tool-invocation';
export {
  ForecastCard,
  LocationCard,
  ToolApprovalCard,
  ToolDeniedCard,
  ToolErrorCard,
  ToolPendingCard,
  ToolResultCard,
  WeatherCard,
} from './components/tool-cards';
export type { ForecastCardData, ForecastCardDay, LocationCardData, WeatherCardData } from './components/tool-cards';
export { DebugPane } from './components/debug-pane';
export type { CallbackLogEntry, ClientToolLogEntry } from './components/debug-pane';
export { IntroCard, COMMON_SCENARIOS } from './components/intro-card';

// Client-side tools + hooks
export { hasClientTool, runClientTool } from './lib/client-tools';
export { useChannelHydration } from './hooks/use-channel-hydration';
export type {
  ChannelHydrationHandle,
  ChannelHydrationState,
  StoredConversation,
  UseChannelHydrationOptions,
} from './hooks/use-channel-hydration';
export { useDemoProgress } from './hooks/use-demo-progress';
export type { Scenario, DemoStepId } from './lib/progress-steps';

// Utilities
export { generateChannelSlug, generateClientName } from './lib/channel-name';
export { clientColor } from './lib/client-color';
export { stopAndCancel } from './lib/stop-and-cancel';
export { assembleWalkedMessages } from './lib/assemble-messages';
