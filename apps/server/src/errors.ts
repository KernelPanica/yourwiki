/** Recovery metadata is explicit; HTTP 5xx never implies safe replay. */
export interface ErrorEnvelope {
  code: string;
  messageKey: string;
  fieldErrors: Record<string, string[]>;
  retryable: boolean;
  operationId: string | null;
  recoveryActions: string[];
  requestId: string;
}

export function errorEnvelope(code: string, requestId: string): ErrorEnvelope {
  return { code, messageKey: `errors.${code.toLowerCase()}`, fieldErrors: {},
    retryable: false, operationId: null, recoveryActions: [], requestId };
}
