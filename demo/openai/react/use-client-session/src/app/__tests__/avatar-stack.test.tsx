import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AvatarStack } from '../components/avatar-stack';

// Shared mock state, declared via vi.hoisted so it is initialised before the
// hoisted vi.mock factory runs — keeping all imports at the top of the file.
// `usePresence` records the channel it was asked to enter; `usePresenceListener`
// returns whatever members the test sets. Only `clientId` is read.
const presence = vi.hoisted(() => ({ data: [] as { clientId: string }[], enter: vi.fn() }));

vi.mock('ably/react', () => ({
  usePresence: (channelName: string) => {
    presence.enter(channelName);
    return { updateStatus: async () => {}, connectionError: null, channelError: null };
  },
  usePresenceListener: () => ({ presenceData: presence.data, connectionError: null, channelError: null }),
}));

afterEach(() => {
  cleanup();
  presence.data = [];
  presence.enter.mockClear();
});

describe('<AvatarStack>', () => {
  it('enters presence on the session channel', () => {
    render(<AvatarStack channelName="ai:demo" />);
    expect(presence.enter).toHaveBeenCalledWith('ai:demo');
  });

  it('renders nothing when no clients are present', () => {
    const { container } = render(<AvatarStack channelName="ai:demo" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one avatar per present client (sorted), showing the first two letters of the clientId', () => {
    // Out of order on the wire — the stack sorts for a stable left-to-right order.
    presence.data = [{ clientId: 'xyzuser' }, { clientId: 'abcuser' }];
    render(<AvatarStack channelName="ai:demo" />);
    const avatars = screen.getAllByTitle(/.+/);
    expect(avatars.map((el) => el.getAttribute('title'))).toEqual(['abcuser', 'xyzuser']);
    expect(avatars.map((el) => el.textContent)).toEqual(['ab', 'xy']);
  });

  it('shows a single avatar per clientId when a client holds multiple connections', () => {
    presence.data = [{ clientId: 'abcuser' }, { clientId: 'abcuser' }, { clientId: 'xyzuser' }];
    render(<AvatarStack channelName="ai:demo" />);
    expect(screen.getAllByTitle(/.+/)).toHaveLength(2);
  });

  it('marks the current client\'s own avatar with "(you)" in its tooltip', () => {
    presence.data = [{ clientId: 'abcuser' }, { clientId: 'xyzuser' }];
    render(
      <AvatarStack
        channelName="ai:demo"
        selfClientId="abcuser"
      />,
    );
    expect(screen.getByTitle('abcuser (you)')).toBeTruthy();
    expect(screen.getByTitle('xyzuser')).toBeTruthy();
  });
});
