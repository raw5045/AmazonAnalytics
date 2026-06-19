import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LoadingOverlay } from './LoadingOverlay';

describe('LoadingOverlay', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(<LoadingOverlay show={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a status overlay with the Loading label when show is true', () => {
    const { container, getByText } = render(<LoadingOverlay show={true} />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(getByText('Loading')).not.toBeNull();
  });
});
