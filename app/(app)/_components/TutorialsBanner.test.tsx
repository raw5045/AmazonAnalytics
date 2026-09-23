import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TutorialsBanner } from './TutorialsBanner';

const KEY = 'kq.tutorials-banner-dismissed';

describe('TutorialsBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows for a browser that has not dismissed it', () => {
    render(<TutorialsBanner />);
    expect(screen.getByRole('link', { name: /watch the tutorials/i })).toBeInTheDocument();
  });

  it('renders nothing once dismissed in this browser', () => {
    localStorage.setItem(KEY, '1');
    const { container } = render(<TutorialsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('dismiss hides it and persists the flag', () => {
    render(<TutorialsBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('link', { name: /watch the tutorials/i })).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe('1');
  });
});
