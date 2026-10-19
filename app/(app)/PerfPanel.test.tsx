// app/(app)/PerfPanel.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PerfPanel } from './PerfPanel';

const data = { totalMs: 420, steps: [{ label: 'auth', ms: 60 }, { label: 'loads', ms: 330, note: 'parallel' }] };

describe('PerfPanel', () => {
  it('renders nothing for a non-admin', () => {
    const { container } = render(<PerfPanel admin={false} data={data} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('for an admin: the summary line, one row per step with its note, and the remainder = total minus the steps', () => {
    render(<PerfPanel admin data={data} />);
    expect(screen.getByText('perf · total=420ms · auth=60ms · loads=330ms')).toBeInTheDocument();
    expect(screen.getByText('(parallel)')).toBeInTheDocument();
    expect(screen.getByText(/remainder/)).toBeInTheDocument();
    expect(screen.getByText('30ms')).toBeInTheDocument(); // 420 − 60 − 330
  });
});
