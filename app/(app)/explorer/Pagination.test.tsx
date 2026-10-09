import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaginationControls } from './Pagination';

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams('q=lamp') }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace }), useSearchParams: () => nav.params }));

describe('PaginationControls basePath', () => {
  beforeEach(() => nav.replace.mockClear());

  it('defaults to /explorer (unchanged) and navigates on the basePath it is given', () => {
    const { unmount } = render(<PaginationControls page={1} hasNext />);
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/explorer?q=lamp&page=2', { scroll: true });
    unmount();

    render(<PaginationControls page={1} hasNext basePath="/products" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/products?q=lamp&page=2', { scroll: true });
  });
});
