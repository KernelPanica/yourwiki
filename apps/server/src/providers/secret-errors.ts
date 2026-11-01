export type SecretErrorCode='INVALID_SECRET_KEY'|'INVALID_SECRET_TOKEN'|'SECRET_TOO_LARGE'|'SECRET_CLOSED'|'SECRET_KEY_UNAVAILABLE'|'INVALID_SECRET_CONFIG';
/** Deliberately never attach input-derived detail or a crypto/filesystem cause. */
export class SecretError extends Error{
 readonly code:SecretErrorCode;
 constructor(code:SecretErrorCode){super(code);this.name='SecretError';this.code=code;}
}
