import type { FieldValue, SignatureAdoption, SigningContext } from '@esign/contracts';

export type DraftSignature = Omit<SignatureAdoption, 'adoptedAt'>;
export type DraftContent = {
  values: Record<string, FieldValue>;
  signature?: DraftSignature | undefined;
};
export type DraftSnapshot = DraftContent & {
  context: SigningContext;
  state: 'saved' | 'unsaved' | 'saving' | 'error';
  error?: string | undefined;
  conflict?: boolean | undefined;
};

// Serialize saves and retain edits made while a request is in flight. A failed
// request never replaces the local draft with a response from an older request.
export class SigningDraft {
  private snapshot: DraftSnapshot;
  private listeners = new Set<() => void>();
  private revision = 0;
  private savedRevision = 0;
  private pending: Promise<void> | undefined;

  constructor(
    context: SigningContext,
    private persist: (context: SigningContext, draft: DraftContent) => Promise<SigningContext>,
  ) {
    this.snapshot = {
      context,
      values: context.recipient.values,
      signature: context.recipient.signature,
      state: 'saved',
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<DraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  edit(patch: Partial<DraftContent>) {
    this.revision++;
    this.publish({ ...patch, state: 'unsaved', error: undefined, conflict: undefined });
  }

  hasUnsavedChanges = () => this.savedRevision !== this.revision;

  save = (): Promise<void> => {
    if (this.pending) return this.pending;
    this.pending = this.flush().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };

  private async flush() {
    try {
      while (this.hasUnsavedChanges()) {
        const revision = this.revision;
        const { context, values, signature } = this.snapshot;
        this.publish({ state: 'saving', error: undefined, conflict: undefined });
        const next = await this.persist(context, { values, signature });
        if (next.envelope.id !== context.envelope.id || next.recipient.id !== context.recipient.id)
          throw new Error('The signing session changed. Reopen your invitation to continue.');
        this.savedRevision = revision;
        this.publish({ context: next });
      }
      this.publish({ state: 'saved', error: undefined, conflict: undefined });
    } catch (error) {
      this.publish({
        state: 'error',
        conflict: Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['progress_conflict', 'version_conflict'].includes(String(error.code)),
        ),
        error:
          error instanceof Error ? error.message : 'Unable to save. Your edits are still here.',
      });
      throw error;
    }
  }
}
