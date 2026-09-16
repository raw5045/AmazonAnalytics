import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButton } from './ExportButton';

function response(status: number, headers: Record<string, string>, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    blob: async () => new Blob(['csv']),
  } as unknown as Response;
}

describe('ExportButton', () => {
  const fetchMock = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clickSpy.mockRestore();
  });

  it('requests the export for the current filters and triggers a download named by the server', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, {
        'x-export-rows': '1234',
        'content-disposition': 'attachment; filename="keywordquarry-keywords-2026-09-12.csv"',
      }),
    );
    render(<ExportButton query="rank_max=100&sort=imp" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await screen.findByText(/Downloaded 1,234 rows/);
    expect(fetchMock).toHaveBeenCalledWith('/api/explorer/export?rank_max=100&sort=imp', expect.anything());
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('says so when the export was cut at the cap', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, { 'x-export-rows': '10000', 'x-export-truncated': 'true', 'content-disposition': 'attachment; filename="x.csv"' }),
    );
    render(<ExportButton query="" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await screen.findByText(/first 10,000 of a larger result/);
  });

  it("shows the server's daily-limit message on 429 and downloads nothing", async () => {
    const msg = 'Daily export limit reached (10 per day). Try again tomorrow.';
    fetchMock.mockResolvedValueOnce(response(429, {}, { error: msg }));
    render(<ExportButton query="rank_max=100" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await screen.findByText(msg);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('shows a generic failure message on other errors', async () => {
    fetchMock.mockResolvedValueOnce(response(500, {}, { error: 'boom' }));
    render(<ExportButton query="rank_max=100" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await screen.findByText(/Export failed/);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('disables itself while the export is in flight', () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    render(<ExportButton query="rank_max=100" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
  });
});
