import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Meter } from './Meter';
describe('Meter', () => {
  it('reads the bar and the questions-left text', () => {
    render(<Meter meter={{ percentUsed: 25, questionsLeft: 187, hasCredit: false, exhausted: false, admin: false }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('about 187 questions left')).toBeInTheDocument();
  });
  it('uses singular "question" when exactly 1 is left (Minor 10)', () => {
    render(<Meter meter={{ percentUsed: 99, questionsLeft: 1, hasCredit: false, exhausted: false, admin: false }} />);
    expect(screen.getByText('about 1 question left')).toBeInTheDocument();
  });
  it('mentions credit, the exhausted line, and the admin line', () => {
    const { rerender } = render(<Meter meter={{ percentUsed: 100, questionsLeft: 50, hasCredit: true, exhausted: false, admin: false }} />);
    expect(screen.getByText('about 50 questions left, including credit')).toBeInTheDocument();
    rerender(<Meter meter={{ percentUsed: 100, questionsLeft: 0, hasCredit: false, exhausted: true, admin: false }} />);
    expect(screen.getByText("You've used this month's usage. Ask through the Feedback button to add more.")).toBeInTheDocument();
    rerender(<Meter meter={{ percentUsed: 0, questionsLeft: 0, hasCredit: false, exhausted: false, admin: true }} />);
    expect(screen.getByText('Admin: usage is metered but not limited.')).toBeInTheDocument();
  });
});
