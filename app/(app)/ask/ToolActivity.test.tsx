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
  it('labels the workspace tools and never shows "Working…" for a part that is waiting on a card or was denied', () => {
    // The thread hands cards to ApprovalCard, not here (a card is a question, not activity — Thread.test.tsx); this is the guard if one ever arrives.
    render(<ToolActivity parts={[{ type: 'tool-create_saved_view', toolCallId: 'a', state: 'approval-requested', input: {}, approval: { id: 'x' } } as never, { type: 'tool-list_saved_views', toolCallId: 'b', state: 'output-available', input: {}, output: {} } as never]} streaming />);
    expect(screen.queryByText(/Working/)).toBeNull();
    expect(screen.getByText('Listing saved views')).toBeInTheDocument();
  });
  it('an answered card (approval-responded) or a denied one (output-denied) is not running either; a running workspace tool shows its own label', () => {
    render(<ToolActivity streaming parts={[part('tool-update_custom_category', 'approval-responded'), part('tool-delete_saved_view', 'output-denied'), part('tool-add_to_watchlist', 'input-available')]} />);
    expect(screen.getByText('Adding to the watchlist…')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
  it('has a label for each of the eleven workspace tools', () => {
    const labels: Record<string, string> = {
      list_saved_views: 'Listing saved views', create_saved_view: 'Saving a view', update_saved_view: 'Changing a view', delete_saved_view: 'Deleting a view',
      list_custom_categories: 'Listing custom categories', create_custom_category: 'Creating a category', update_custom_category: 'Changing a category', delete_custom_category: 'Deleting a category',
      list_watchlist: 'Listing the watchlist', add_to_watchlist: 'Adding to the watchlist', remove_from_watchlist: 'Removing from the watchlist',
    };
    render(<ToolActivity streaming={false} parts={Object.keys(labels).map((name) => part(`tool-${name}`, 'output-available'))} />);
    for (const label of Object.values(labels)) expect(screen.getByText(label)).toBeInTheDocument();
  });
  it('labels the two admin-only products tools, running and finished, never "Working…"', () => {
    const { unmount } = render(<ToolActivity streaming parts={[part('tool-search_products', 'input-available'), part('tool-get_product_details', 'input-streaming', { asin: 'B0ABCDEF12' })]} />);
    expect(screen.getByText('Searching products…')).toBeInTheDocument();
    expect(screen.getByText('Loading product details…')).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).toBeNull();
    unmount();
    render(<ToolActivity streaming={false} parts={[part('tool-search_products', 'output-available'), part('tool-get_product_details', 'output-available', { asin: 'B0ABCDEF12' })]} />);
    expect(screen.getByText('Searching products')).toBeInTheDocument();
    expect(screen.getByText('Loading product details')).toBeInTheDocument();
  });
});
