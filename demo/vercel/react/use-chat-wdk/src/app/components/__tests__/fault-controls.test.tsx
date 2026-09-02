import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FaultControls } from '../fault-controls';

describe('FaultControls', () => {
  it('arms a fault mode when its button is clicked', () => {
    const onChange = vi.fn();
    render(
      <FaultControls
        fault={undefined}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fail once' }));
    expect(onChange).toHaveBeenCalledWith('fail-once');

    fireEvent.click(screen.getByRole('button', { name: 'Crash' }));
    expect(onChange).toHaveBeenCalledWith('crash');
  });

  it('disarms when No fault is clicked', () => {
    const onChange = vi.fn();
    render(
      <FaultControls
        fault="crash"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No fault' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('shows an armed hint only while a fault is armed', () => {
    const { rerender } = render(
      <FaultControls
        fault={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Armed/i)).toBeNull();

    rerender(
      <FaultControls
        fault="fail-once"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Armed/i)).toBeTruthy();
  });
});
