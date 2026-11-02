/** UI-independent optimistic save bookkeeping; a save never consumes later edits. */
export class PdfSaveState {
  version = 0;
  savedVersion = 0;
  saving = false;
  paused = false;
  baseRevision: number;
  layerRevision: number;
  constructor(baseRevision: number, layerRevision: number) {
    this.baseRevision = baseRevision; this.layerRevision = layerRevision;
  }
  get dirty() { return this.version !== this.savedVersion; }
  changed() { this.version++; }
  begin() {
    if (!this.dirty || this.saving || this.paused) return null;
    this.saving = true;
    return { version: this.version, baseRevision: this.baseRevision, layerRevision: this.layerRevision };
  }
  complete(snapshot: { version: number; baseRevision: number; layerRevision: number }, receipt: { baseRevision: number; layerRevision: number }) {
    if (!this.saving || receipt.baseRevision !== snapshot.baseRevision || receipt.layerRevision !== snapshot.layerRevision + 1) {
      this.saving = false; this.paused = true;
      throw new Error('INVALID_SAVE_RECEIPT');
    }
    this.layerRevision = receipt.layerRevision; this.savedVersion = snapshot.version; this.saving = false;
  }
  fail() { this.saving = false; this.paused = true; }
  remote(baseRevision: number, layerRevision: number) {
    if (baseRevision === this.baseRevision && layerRevision === this.layerRevision) return 'unchanged';
    this.paused = true;
    return this.dirty || this.saving ? 'conflict' : 'reload';
  }
}
