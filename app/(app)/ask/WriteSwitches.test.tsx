import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WriteSwitches, type WriteToggles } from './WriteSwitches';

/** What onChange receives: an updater on the current pair (AskAi applies it to its state). */
type Update = (prev: WriteToggles) => WriteToggles;
const OFF: WriteToggles = { autoApproveChanges: false, autoApproveDeletes: false };
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

/** What the n-th recorded updater (1-based) makes of `prev`. */
const nth = (onChange: Mock<(update: Update) => void>, n: number, prev: WriteToggles): WriteToggles => onChange.mock.calls[n - 1][0](prev);

/** AskAi's side of the controlled pair: it holds the values and applies each updater; every call is recorded too. */
function Harness({ initial, onChange }: { initial: WriteToggles; onChange: (update: Update) => void }) {
  const [value, setValue] = useState(initial);
  return <WriteSwitches value={value} onChange={(update) => { onChange(update); setValue(update); }} />;
}

describe('WriteSwitches (spec 2026-10-01 §8)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the two switches with the given values and their notes as descriptions (not printed), under "Approvals"', () => {
    render(<WriteSwitches value={{ autoApproveChanges: false, autoApproveDeletes: true }} onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Approvals' });
    expect(changesBox()).not.toBeChecked();
    expect(deletesBox()).toBeChecked();
    expect(changesBox()).toHaveAccessibleDescription('Ask AI will not ask before saving or changing things.');
    expect(deletesBox()).toHaveAccessibleDescription('Ask AI will not ask before deleting things — deletes are permanent.');
    // The notes are descriptions only (sr-only); one visible line covers both switches.
    expect(screen.getByText('Off, Ask AI asks in a card first. Deletes are permanent.')).toBeInTheDocument();
    expect(screen.getByText('Ask AI will not ask before saving or changing things.')).toHaveClass('sr-only');
    expect(screen.getByText('Ask AI will not ask before deleting things — deletes are permanent.')).toHaveClass('sr-only');
    expect(changesBox()).toBeEnabled();
    expect(deletesBox()).toBeEnabled();
    // The live line is in the page from the start (empty), so a later error is announced.
    expect(group.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a toggle shows at once, PATCHes only its own field, then takes both values from the answer', async () => {
    const onChange = vi.fn<(update: Update) => void>();
    render(<Harness initial={OFF} onChange={onChange} />);
    // The answer is the row: deletes is already on there (set from another tab), so that switch follows it.
    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: true }));
    fireEvent.click(changesBox());
    expect(onChange).toHaveBeenCalledTimes(1);
    // An updater on the pair as it is by then: the other switch is kept, never copied from this render.
    expect(nth(onChange, 1, OFF)).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
    expect(nth(onChange, 1, { autoApproveChanges: false, autoApproveDeletes: true })).toEqual({ autoApproveChanges: true, autoApproveDeletes: true });
    expect(changesBox()).toBeChecked();
    // 'PATCH' in capitals: fetch upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT, so a
    // lower-case 'patch' would reach Next as written and be answered 405.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ACCOUNT_URL, patchOf({ autoApproveChanges: true }));
    await waitFor(() => expect(deletesBox()).toBeChecked());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(nth(onChange, 2, OFF)).toEqual({ autoApproveChanges: true, autoApproveDeletes: true }); // the answer, whatever the pair was
    expect(changesBox()).toBeChecked();

    // Turning one off sends false, again for that field only.
    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: false }));
    fireEvent.click(deletesBox());
    expect(nth(onChange, 3, { autoApproveChanges: true, autoApproveDeletes: true })).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(ACCOUNT_URL, patchOf({ autoApproveDeletes: false }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(4));
    expect(nth(onChange, 4, OFF)).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
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
  ])('a failed save (%s) puts that switch back and says so in the live line; a new attempt clears it', async (_case, failOnce) => {
    const onChange = vi.fn<(update: Update) => void>();
    render(<Harness initial={{ autoApproveChanges: false, autoApproveDeletes: true }} onChange={onChange} />);
    failOnce();
    fireEvent.click(changesBox());
    expect(changesBox()).toBeChecked();
    const line = await screen.findByText(SAVE_FAILED);
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onChange).toHaveBeenCalledTimes(2);
    // The revert is an updater too: it puts back only this switch.
    expect(nth(onChange, 2, { autoApproveChanges: true, autoApproveDeletes: true })).toEqual({ autoApproveChanges: false, autoApproveDeletes: true });
    await waitFor(() => expect(changesBox()).toBeEnabled());
    expect(changesBox()).not.toBeChecked();
    expect(deletesBox()).toBeChecked();

    fetchMock.mockResolvedValueOnce(answer({ autoApproveChanges: true, autoApproveDeletes: true }));
    fireEvent.click(changesBox());
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    await waitFor(() => expect(changesBox()).toBeEnabled());
    expect(changesBox()).toBeChecked();
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it('an "Always approve" flipped in the thread while a save is out survives both the optimistic write and the revert', async () => {
    let fail: (reason: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const onChange = vi.fn<(update: Update) => void>();
    render(<WriteSwitches value={OFF} onChange={onChange} />);
    fireEvent.click(changesBox());
    // AskAi applies each updater to its state in turn with onAlwaysApproved('deletes'), which can
    // land before or after it: applied to a pair that already has deletes on, each one keeps it.
    expect(nth(onChange, 1, { autoApproveChanges: false, autoApproveDeletes: true })).toEqual({ autoApproveChanges: true, autoApproveDeletes: true });
    fail(new TypeError('Failed to fetch'));
    expect(await screen.findByText(SAVE_FAILED)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(nth(onChange, 2, { autoApproveChanges: true, autoApproveDeletes: true })).toEqual({ autoApproveChanges: false, autoApproveDeletes: true });
  });

  it('a second failure in a row is announced again: the new attempt clears the line before it fails', async () => {
    render(<Harness initial={OFF} onChange={vi.fn()} />);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fireEvent.click(changesBox());
    await screen.findByText(SAVE_FAILED);
    await waitFor(() => expect(changesBox()).toBeEnabled());
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(changesBox());
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    expect(await screen.findByText(SAVE_FAILED)).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(changesBox()).toBeEnabled());
    expect(changesBox()).not.toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
