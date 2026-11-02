/** Stable document errors shared by commit, history and transport layers. */
export class DocumentError extends Error {
  code: string; recoveryId: string | null;
  constructor(code: string, recoveryId: string | null = null) { super(code); this.code = code; this.recoveryId = recoveryId; }
}
