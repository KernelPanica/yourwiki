/** Owned CLI fixture only: Google requests can reach loopback, never the internet. */
const origin=new URL(process.env.YOURWIKI_TEST_GOOGLE_ORIGIN??'');
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Owned provider origin required');
const request=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const url=new URL(String(input));if(!['https://oauth2.googleapis.com','https://www.googleapis.com'].includes(url.origin))throw new Error('Unexpected owned provider request');return request(origin.origin+url.pathname+url.search,init);};
export {};
