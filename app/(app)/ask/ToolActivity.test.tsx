import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolActivity } from './ToolActivity';
const part = (type: string, state: string, input: unknown = { filters: {} }) => ({ type, toolCallId: `${type}-1`, state, input }) as never;
describe('ToolActivity', () => {
  it('shows a status line per running tool while streaming', () => {
    render(<ToolActivity streaming parts={[part('tool-resolve_categories', 'output-available'), part('tool-search_keywords', 'input-available')]} />);
    expect(screen.getByText('Searching keywords…')).toBeInTheDocument();
    expect(screen.queryByText(/Used 2 tools/)).not.toBeInTheDocument();
  });
  it('folds finished calls into a disclosure listing tool and compact input', () => {
    render(<ToolActivity streaming={false} parts={[part('tool-search_keywords', 'output-available', { filters: { text: 'lamp' } }), part('tool-get_keyword_details', 'output-error')]} />);
    const summary = screen.getByText('Used 2 tools');
    expect(summary.closest('details')).not.toBeNull();
    expect(screen.getByText('Searching keywords')).toBeInTheDocument();
    expect(screen.getByText('{"filters":{"text":"lamp"}}')).toBeInTheDocument();
  });
  it('renders nothing without tool parts', () => {
    const { container } = render(<ToolActivity streaming={false} parts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
