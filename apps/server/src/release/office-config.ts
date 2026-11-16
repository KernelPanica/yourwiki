import {officeUrl} from '../office/discovery.ts';
import type {OfficeOptions} from '../office/routes.ts';
/** Editor hosts are explicitly configured; Collabora remains the default. */
export function configuredOffice(environment:NodeJS.ProcessEnv):OfficeOptions|undefined{
 const engine=environment.YOURWIKI_OFFICE_ENGINE??'collabora';if(!['collabora','onlyoffice'].includes(engine))throw new Error('INVALID_OFFICE_CONFIG');
 const prefix=engine==='onlyoffice'?'ONLYOFFICE':'COLLABORA';
 const publicUrl=environment[prefix+'_URL']??'',internalUrl=environment[prefix+'_INTERNAL_URL']??'',wopiUrl=environment[prefix+'_WOPI_URL']??'';
 if(!publicUrl){if(internalUrl||wopiUrl)throw new Error('INVALID_OFFICE_CONFIG');return undefined;}
 const validatePublic=(value:string)=>{const url=officeUrl(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('INVALID_OFFICE_CONFIG');};
 validatePublic(publicUrl);if(internalUrl)officeUrl(internalUrl);if(wopiUrl){if(engine==='onlyoffice')officeUrl(wopiUrl);else validatePublic(wopiUrl);}
 return {engine:engine as 'collabora'|'onlyoffice',publicUrl,...(internalUrl?{internalUrl}:{}),...(wopiUrl?{wopiUrl}:{})};
}
