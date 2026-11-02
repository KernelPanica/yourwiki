export class ConversionError extends Error {
  code: string; terminal: boolean;
  constructor(code: string, terminal = true) { super(code); this.code = code; this.terminal = terminal; }
}
