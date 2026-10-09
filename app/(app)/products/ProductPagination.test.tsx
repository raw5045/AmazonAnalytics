import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProductPagination } from './ProductPagination';

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace }), useSearchParams: () => nav.params }));

describe('ProductPagination', () => {
  beforeEach(() => nav.replace.mockClear());

  it('Next replaces with /products?…&page=2, keeping the other params', () => {
    nav.params = new URLSearchParams('age=180&soldMin=1000');
    render(<ProductPagination page={1} total={120} totalIsCapped={false} pageSize={50} />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(nav.replace).toHaveBeenCalledWith('/products?age=180&soldMin=1000&page=2', { scroll: true });
  });

  it('Prev back to page 1 drops the page param', () => {
    nav.params = new URLSearchParams('age=180&page=2');
    render(<ProductPagination page={2} total={120} totalIsCapped={false} pageSize={50} />);
    fireEvent.click(screen.getByRole('button', { name: '‹ Prev' }));
    expect(nav.replace).toHaveBeenCalledWith('/products?age=180', { scroll: true });
  });

  it('a capped count reads "of 200+" and the last reachable page has no Next', () => {
    nav.params = new URLSearchParams('page=200');
    render(<ProductPagination page={200} total={10_000} totalIsCapped pageSize={50} />);
    expect(screen.getByText('Page 200 of 200+')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next ›' })).toBeDisabled();
  });

  it('renders nothing past the last page (the results area links back to page 1)', () => {
    nav.params = new URLSearchParams('age=180&page=9');
    const { container } = render(<ProductPagination page={9} total={120} totalIsCapped={false} pageSize={50} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a single page of results', () => {
    nav.params = new URLSearchParams();
    const { container } = render(<ProductPagination page={1} total={50} totalIsCapped={false} pageSize={50} />);
    expect(container).toBeEmptyDOMElement();
  });
});
