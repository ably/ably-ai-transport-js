import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Drive the presence hooks from the test. `usePresence` records the channel it
// was asked to enter; `usePresenceListener` returns whatever members the test
// sets. Only the `clientId` field is read by the component.
let mockPresenceData: { clientId: string }[] = [];
const enterPresence = vi.fn();

vi.mock('ably/react', () => ({
  usePresence: (channelName: string) => {
    enterPresence(channelName);
    return { updateStatus: async () => {}, connectionError: null, channelError: null };
  },
  usePresenceListener: () => ({ presenceData: mockPresenceData, connectionError: null, channelError: null }),
}));

// Imported after vi.mock so it picks up the mocked presence hooks.
 
import { AvatarStack } from '../components/avatar-stack';

afterEach(() => {
  cleanup();
  mockPresenceData = [];
  enterPresence.mockClear();
});

describe('<AvatarStack>', () => {
  it('enters presence on the session channel', () => {
    render(<AvatarStack channelName="ai:demo" />);
    expect(enterPresence).toHaveBeenCalledWith('ai:demo');
  });

  it('renders nothing when no clients are present', () => {
    const { container } = render(<AvatarStack channelName="ai:demo" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one avatar per present client (sorted), showing the first two letters of the clientId', () => {
    // Out of order on the wire — the stack sorts for a stable left-to-right order.
    mockPresenceData = [{ clientId: 'xyzuser' }, { clientId: 'abcuser' }];
    render(<AvatarStack channelName="ai:demo" />);
    const avatars = screen.getAllByTitle(/.+/);
    expect(avatars.map((el) => el.getAttribute('title'))).toEqual(['abcuser', 'xyzuser']);
    expect(avatars.map((el) => el.textContent)).toEqual(['ab', 'xy']);
  });

  it('shows a single avatar per clientId when a client holds multiple connections', () => {
    mockPresenceData = [{ clientId: 'abcuser' }, { clientId: 'abcuser' }, { clientId: 'xyzuser' }];
    render(<AvatarStack channelName="ai:demo" />);
    expect(screen.getAllByTitle(/.+/)).toHaveLength(2);
  });

  it('marks the current client\'s own avatar with "(you)" in its tooltip', () => {
    mockPresenceData = [{ clientId: 'abcuser' }, { clientId: 'xyzuser' }];
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
