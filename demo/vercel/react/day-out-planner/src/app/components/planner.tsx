'use client';

import { Header } from './header';
import { ChatPane } from './chat-pane';
import { MapPane } from './map-pane';
import { ItineraryList } from './itinerary-list';
import { SessionHooks } from '../providers';
import { useItinerary } from '../hooks/use-itinerary';

const { useView } = SessionHooks;

interface PlannerProps {
  channelName: string;
  name: string;
  onChangeName: () => void;
}

export function Planner({ channelName, name, onChangeName }: PlannerProps) {
  const view = useView({ limit: 50 });
  const items = useItinerary(channelName);

  return (
    <div className="flex h-dvh flex-col">
      <Header
        channelName={channelName}
        name={name}
        onChangeName={onChangeName}
      />
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-1 flex-col border-r border-zinc-800">
          <ChatPane
            view={view}
            ownName={name}
          />
        </div>
        <div className="flex w-1/2 flex-col">
          <div className="flex-1 min-h-0">
            <MapPane items={items} />
          </div>
          <div className="max-h-1/3 min-h-[8rem] overflow-y-auto border-t border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
              Itinerary
            </div>
            <ItineraryList items={items} />
          </div>
        </div>
      </div>
    </div>
  );
}
