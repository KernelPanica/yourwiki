/** Drive version changes for permissions/metadata too. The binary metadata hash
 * includes MIME, parents, size, MD5, SHA256 and headRevisionId; compare identity
 * and this complete hash, never merely version or MD5. Callers still verify bytes
 * or a stable content revision, and writes always use the current strong ETag. */
export function sameGoogleBinaryContent(a:string,b:string){
 try{const x=JSON.parse(a),y=JSON.parse(b);return [x,y].every(v=>Array.isArray(v)&&v.length===4&&v[0]==='google-binary-v2'&&typeof v[1]==='string'&&typeof v[2]==='string'&&typeof v[3]==='string'&&/^[a-f0-9]{64}$/.test(v[3]))&&x[1]===y[1]&&x[3]===y[3];}catch{return false;}
}
