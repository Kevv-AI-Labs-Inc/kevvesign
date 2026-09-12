import { describe, expect, it, vi } from 'vitest';
import type { SigningContext } from '@esign/contracts';
import { SigningDraft } from './signing-draft';

const initial = {
  envelope: { id: 'agreement-a', version: 1 },
  recipient: { id: 'person-a', values: {}, progressVersion: 0 },
} as SigningContext;

function saved(version: number): SigningContext {
  return { ...initial, recipient: { ...initial.recipient, progressVersion: version } };
}

describe('recoverable signing draft', () => {
  it('serializes requests and saves edits made while an earlier save is in flight', async () => {
    let release!: (context: SigningContext) => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SigningContext>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(saved(2));
    const draft = new SigningDraft(initial, persist);
    draft.edit({ values: { name: 'First draft' } });
    const pending = draft.save();
    draft.edit({ values: { name: 'Latest draft' } });
    const repeated = draft.save();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(repeated).toBe(pending);
    release(saved(1));
    await pending;
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]![0].recipient.progressVersion).toBe(1);
    expect(persist.mock.calls[1]![1].values.name).toBe('Latest draft');
    expect(draft.getSnapshot().values.name).toBe('Latest draft');
    expect(draft.getSnapshot().state).toBe('saved');
    expect(draft.hasUnsavedChanges()).toBe(false);
  });

  it('keeps unsaved edits after a network failure and retries them', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(saved(1));
    const draft = new SigningDraft(initial, persist);
    draft.edit({ values: { name: 'Keep my edits' } });
    await expect(draft.save()).rejects.toThrow('Offline');
    expect(draft.getSnapshot()).toMatchObject({
      state: 'error',
      values: { name: 'Keep my edits' },
    });
    expect(draft.hasUnsavedChanges()).toBe(true);
    await draft.save();
    expect(draft.getSnapshot().state).toBe('saved');
  });

  it('does not report saved or replace local edits after a conflict or identity mismatch', async () => {
    const conflict = Object.assign(new Error('Changed on another device'), {
      code: 'progress_conflict',
    });
    const persist = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        ...saved(1),
        recipient: { ...initial.recipient, id: 'someone-else' },
      });
    const draft = new SigningDraft(initial, persist);
    draft.edit({ values: { name: 'Uncommitted' } });
    await expect(draft.save()).rejects.toThrow('Changed on another device');
    expect(draft.getSnapshot().conflict).toBe(true);
    await expect(draft.save()).rejects.toThrow('session changed');
    expect(draft.hasUnsavedChanges()).toBe(true);
    expect(draft.getSnapshot().values.name).toBe('Uncommitted');
    expect(draft.getSnapshot().context.recipient.id).toBe('person-a');
  });
});
