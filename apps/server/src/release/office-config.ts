import {officeUrl} from '../office/discovery.ts';
import type {OfficeOptions} from '../office/routes.ts';
/** Explicitly configured Collabora only; never infer an external editor host. */
export function configuredOffice(environment:NodeJS.ProcessEnv):OfficeOptions|undefined{
 const publicUrl=environment.COLLABORA_URL??'',internalUrl=environment.COLLABORA_INTERNAL_URL??'',wopiUrl=environment.COLLABORA_WOPI_URL??'';
 if(!publicUrl){if(internalUrl||wopiUrl)throw new Error('INVALID_OFFICE_CONFIG');return undefined;}
 const validatePublic=(value:string)=>{const url=officeUrl(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('INVALID_OFFICE_CONFIG');};
 validatePublic(publicUrl);if(internalUrl)officeUrl(internalUrl);if(wopiUrl)validatePublic(wopiUrl);
 return {publicUrl,...(internalUrl?{internalUrl}:{}),...(wopiUrl?{wopiUrl}:{})};
}
