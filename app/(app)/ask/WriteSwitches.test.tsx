import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WriteSwitches, type WriteToggles } from './WriteSwitches';

const ACCOUNT_URL = '/api/ask/account';
const SAVE_FAILED = 'Could not save that setting. Try again.';
const changesBox = () => screen.getByRole('checkbox', { name: 'Changes: always allow' });
const deletesBox = () => screen.getByRole('checkbox', { name: 'Deletes: always allow' });
/** The route's 200: both toggles, read back from the updated row. */
const answer = (toggles: WriteToggles) => Response.json(toggles, { headers: { 'cache-control': 'no-store' } });
/** The exact request one toggle sends: its own field only. */
const patchOf = (body: Partial<WriteToggles>) => ({
  method: 'PATCH', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body),
});

/** AskAi's side of the controlled pair: it holds the values; every onChange call is recorded too. */
function Harness({ initial, onChange }: { initial: WriteToggles; onChange: (next: WriteToggles) => void }) {
  const [value, setValue] = useState(initial);
  return <WriteSwitches value={value} onChange={(next) => { onChange(next); setValue(next); }} />;
}

describe('WriteSwitches (spec 2026-10-01 §8)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the two switches with the given values and their one-line notes, under "Approvals"', () => {
    render(<WriteSwitches value={{ autoApproveChanges: false, autoApproveDeletes: true }} onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Approvals' });
    expect(changesBox()).not.toBeChecked();
    expect(deletesBox()).toBeChecked();
    expect(changesBox()).toHaveAccessibleDescription('Ask AI will not ask before saving or changing things.');
    expect(deletesBox()).toHaveAccessibleDescription('Ask AI will not ask before deleting things — deletes are permanent.');
    expect(changesBox()).toBeEnabled();
    expect(deletesBox()).toBeEnabled();
    // The live line is in the page from the start (empty), so a later error is announced.
    expect(group.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a toggle shows at once, PATCHes only its own field, then takes both values from the answer', async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ autoApproveChanges: false, autoApproveDeletes: false }} onChange={onChange} />);
    // The answer is the row: deletes is already on there (set from another tab), so that switch follows it.
    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: true }));
    fireEvent.click(changesBox());
    expect(onChange).toHaveBeenNthCalledWith(1, { autoApproveChanges: true, autoApproveDeletes: false });
    expect(changesBox()).toBeChecked();
    // 'PATCH' in capitals: fetch upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT, so a
    // lower-case 'patch' would reach Next as written and be answered 405.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ACCOUNT_URL, patchOf({ autoApproveChanges: true }));
    await waitFor(() => expect(deletesBox()).toBeChecked());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(2, { autoApproveChanges: true, autoApproveDeletes: true });
    expect(changesBox()).toBeChecked();

    // Turning one off sends false, again for that field only.
    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: false }));
    fireEvent.click(deletesBox());
    expect(onChange).toHaveBeenNthCalledWith(3, { autoApproveChanges: true, autoApproveDeletes: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(ACCOUNT_URL, patchOf({ autoApproveDeletes: false }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(4));
    expect(onChange).toHaveBeenNthCalledWith(4, { autoApproveChanges: true, autoApproveDeletes: false });
    await waitFor(() => expect(deletesBox()).toBeEnabled());
    expect(deletesBox()).not.toBeChecked();
    expect(changesBox()).toBeChecked();
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it.each([
    ['a bodyless 404 (writes switched off, or no account row)', () => fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))],
    ['a server error', () => fetchMock.mockResolvedValueOnce(Response.json({ error: 'Something went wrong.' }, { status: 500 }))],
    ['a rejected fetch (offline)', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
    ['a 200 whose body is not the two toggles', () => fetchMock.mockResolvedValueOnce(Response.json({ autoApproveChanges: true }))],
  ])('a failed save (%s) puts the switch back and says so in the live line; the next good save clears it', async (_case, failOnce) => {
    const onChange = vi.fn();
    render(<Harness initial={{ autoApproveChanges: false, autoApproveDeletes: true }} onChange={onChange} />);
    failOnce();
    fireEvent.click(changesBox());
    expect(changesBox()).toBeChecked();
    const line = await screen.findByText(SAVE_FAILED);
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onChange.mock.calls).toEqual([
      [{ autoApproveChanges: true, autoApproveDeletes: true }],
      [{ autoApproveChanges: false, autoApproveDeletes: true }],
    ]);
    await waitFor(() => expect(changesBox()).toBeEnabled());
    expect(changesBox()).not.toBeChecked();
    expect(deletesBox()).toBeChecked();

    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: true }));
    fireEvent.click(changesBox());
    await waitFor(() => expect(screen.queryByText(SAVE_FAILED)).toBeNull());
    expect(changesBox()).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith({ autoApproveChanges: true, autoApproveDeletes: true });
  });

  it('a failed save puts back only its own switch: an "Always approve" answered in the thread meanwhile stays on', async () => {
    let fail: (reason: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const onChange = vi.fn();
    const { rerender } = render(<WriteSwitches value={{ autoApproveChanges: false, autoApproveDeletes: false }} onChange={onChange} />);
    fireEvent.click(changesBox());
    expect(onChange).toHaveBeenLastCalledWith({ autoApproveChanges: true, autoApproveDeletes: false });
    // AskAi shows the optimistic value, then onAlwaysApproved('deletes') lands while the PATCH is out.
    rerender(<WriteSwitches value={{ autoApproveChanges: true, autoApproveDeletes: true }} onChange={onChange} />);
    fail(new TypeError('Failed to fetch'));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenLastCalledWith({ autoApproveChanges: false, autoApproveDeletes: true });
    expect(await screen.findByText(SAVE_FAILED)).toBeInTheDocument();
  });

  it('disables BOTH switches while a save is out, so there is only ever one request at a time', async () => {
    let finish: (res: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    render(<Harness initial={{ autoApproveChanges: false, autoApproveDeletes: false }} onChange={vi.fn()} />);
    fireEvent.click(changesBox());
    expect(changesBox()).toBeDisabled();
    expect(deletesBox()).toBeDisabled();
    fireEvent.click(deletesBox());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(answer({ autoApproveChanges: true, autoApproveDeletes: false }));
    await waitFor(() => expect(changesBox()).toBeEnabled());
    expect(deletesBox()).toBeEnabled();
    expect(changesBox()).toBeChecked();
    expect(deletesBox()).not.toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
