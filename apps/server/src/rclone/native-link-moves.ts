import type {GoogleControlHttp,GoogleControlScope} from '../providers/google-control-http.ts';

type File={id:string;name:string;mimeType:string;parents?:string[];trashed?:boolean;version?:string;driveId?:string};
export type MovePlan={status:'ready'|'outside-root';original:File;target:File;relativePath:string;folders:string[];driveRoot:string};
const folderMime='application/vnd.google-apps.folder',native=new Set(['application/vnd.google-apps.document','application/vnd.google-apps.spreadsheet','application/vnd.google-apps.presentation']);
const fields='id,name,mimeType,parents,trashed,version,driveId';
const quoted=(value:string)=>"'"+value.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";
const safeName=(value:string)=>{if(!value||/[\/\\\x00-\x1f\x7f]/.test(value)||['.','..'].includes(value))throw Error('INVALID_DRIVE_NAME');return value;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** Control-plane only: no rclone path lookup, no binary writes, no filename
 * guesses. The operator supplies a live binding guard and a durable audit sink. */
export class NativeOriginalMover{
 private http:Pick<GoogleControlHttp,'call'>;private sourceRoot:string;private isBound:(id:string)=>boolean;private check:()=>void;
 constructor(http:Pick<GoogleControlHttp,'call'>,sourceRoot:string,isBound:(id:string)=>boolean,check:()=>void=()=>{}){
  if(!/^[-\w]{1,256}$/.test(sourceRoot)||sourceRoot==='root')throw Error('EXPLICIT_YOURWIKI_ROOT_REQUIRED');
  this.http=http;this.sourceRoot=sourceRoot;this.isBound=isBound;this.check=check;
 }
 private scope(originalId?:string):GoogleControlScope{const check=originalId?()=>this.guard(originalId):this.check;return {check,beforeDispatch:check};}
 private async get(id:string):Promise<File>{const file=await this.http.call('GET','files/'+id,{fields},undefined,this.scope()) as File;if(!file?.id||file.trashed)throw Error('DRIVE_FILE_UNAVAILABLE');return file;}
 private async children(parent:string,name:string):Promise<File[]>{
  const result=await this.http.call('GET','files',{q:quoted(parent)+' in parents and trashed = false and name = '+quoted(name),fields:'nextPageToken,files('+fields+')',pageSize:'100'},undefined,this.scope());
  if(result.nextPageToken||!Array.isArray(result.files))throw Error('AMBIGUOUS_DRIVE_PATH');return result.files as File[];
 }
 private guard(id:string){this.check();if(this.isBound(id))throw Error('ORIGINAL_STILL_BOUND');}
 async plan(originalId:string,targetId:string):Promise<MovePlan>{
  this.guard(originalId);const original=await this.get(originalId);
  if(!native.has(original.mimeType))throw Error('ORIGINAL_NOT_NATIVE');
  if(original.driveId)throw Error('SHARED_DRIVE_UNSUPPORTED');
  const target=await this.get(targetId);if(native.has(target.mimeType)||target.mimeType.startsWith('application/vnd.google-apps.')||original.id===target.id)throw Error('TARGET_NOT_BINARY');
  const root=await this.get('root');if(root.id===this.sourceRoot)throw Error('EXPLICIT_YOURWIKI_ROOT_REQUIRED');
  const folders:string[]=[],seen=new Set<string>();let current=original;
  while(true){
   if(current.parents?.length!==1||seen.has(current.id)||seen.size>=128)throw Error('AMBIGUOUS_DRIVE_ANCESTRY');seen.add(current.id);
   const parent=current.parents[0]!;
   if(parent===root.id)return {status:'outside-root',original,target,folders:[],relativePath:'',driveRoot:root.id};
   const siblings=await this.children(parent,safeName(current.name));if(siblings.length!==1||siblings[0]!.id!==current.id)throw Error('AMBIGUOUS_DRIVE_PATH');
   if(parent===this.sourceRoot)break;
   current=await this.get(parent);if(current.mimeType!==folderMime||current.driveId)throw Error('INVALID_SOURCE_FOLDER');folders.unshift(safeName(current.name));
  }
  let parent:string|undefined=root.id;
  for(const name of folders){if(!parent)break;const matches=await this.children(parent,name);if(matches.length>1||matches.some(f=>f.mimeType!==folderMime))throw Error('AMBIGUOUS_DESTINATION');parent=matches[0]?.id;if(parent===this.sourceRoot)throw Error('DESTINATION_INSIDE_YOURWIKI');}
  if(parent&&(await this.children(parent,original.name)).length)throw Error('DESTINATION_EXISTS');
  return {status:'ready',original,target,folders,relativePath:[...folders,original.name].join('/'),driveRoot:root.id};
 }
 async move(plan:MovePlan,confirmed:boolean,record:(event:Record<string,unknown>)=>void|Promise<void>=()=>{}){
  if(!confirmed)throw Error('MOVE_CONFIRMATION_REQUIRED');if(plan.status!=='ready')return;
  const fresh=await this.plan(plan.original.id,plan.target.id);
  if(!same(fresh,plan))throw Error('DRIVE_CHANGED_SINCE_PLAN');
  await record({event:'move-planned',...plan});let parent=plan.driveRoot;
  for(const name of plan.folders){
   this.guard(plan.original.id);const matches=await this.children(parent,name);
   if(matches.length>1||matches.some(f=>f.mimeType!==folderMime))throw Error('AMBIGUOUS_DESTINATION');
   if(matches.length)parent=matches[0]!.id;
   else{
    await record({event:'folder-create-dispatch',name,parent});
    const created=await this.http.call('POST','files',{fields},{name,mimeType:folderMime,parents:[parent]},this.scope(plan.original.id)) as File;
    // An uncertain create stops the run; the next run discovers its result by name.
    const verified=await this.children(parent,name);if(verified.length!==1||verified[0]!.id!==created.id)throw Error('AMBIGUOUS_DESTINATION');
    parent=created.id;await record({event:'folder-created',file:created});
   }
   if(parent===this.sourceRoot)throw Error('DESTINATION_INSIDE_YOURWIKI');
  }
  this.guard(plan.original.id);
  if((await this.children(parent,plan.original.name)).length)throw Error('DESTINATION_EXISTS');
  if(!same(await this.get(plan.original.id),plan.original)||!same(await this.get(plan.target.id),plan.target))throw Error('DRIVE_CHANGED_SINCE_PLAN');
  await record({event:'move-dispatch',id:plan.original.id,from:plan.original.parents,to:parent});
  this.guard(plan.original.id);
  await this.http.call('PATCH','files/'+plan.original.id,{fields,addParents:parent,removeParents:plan.original.parents!.join(',')},{},this.scope(plan.original.id));
  const verified=await this.get(plan.original.id);if(verified.parents?.length!==1||verified.parents[0]!==parent)throw Error('MOVE_NOT_VERIFIED');
  await record({event:'moved',file:verified});
 }
}
