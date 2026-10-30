import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startChangeFeed} from '../src/live-updates.ts';
import {blockSession,resumeSession} from '../src/session-fence.ts';
class Source {
 listeners=new Map<string,(event:{data:string})=>void>();closed=false;
 addEventListener(type:string,listener:(event:{data:string})=>void){this.listeners.set(type,listener);}
 close(){this.closed=true;}
 emit(type:string,data='{}'){this.listeners.get(type)?.({data});}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('feed verifies identity before dispatch and coalesces hints; session block closes IO',async()=>{
 resumeSession();const source=new Source();let verify!: (value:boolean)=>void;const events:unknown[]=[];
 const stop=startChangeFeed({create:()=>source,verify:()=>new Promise(resolve=>{verify=resolve;}),changed:event=>events.push(event),expired:()=>assert.fail('unexpected expiry')});
 source.emit('ready');source.emit('documents',JSON.stringify({documentIds:['a']}));await settle();assert.deepEqual(events,[]);
 verify(true);await settle();assert.deepEqual(events,[{type:'all'}]);
 source.emit('documents',JSON.stringify({documentIds:['a']}));source.emit('documents',JSON.stringify({documentIds:['b','a']}));await settle();assert.deepEqual(events.at(-1),{type:'documents',documentIds:['a','b']});
 blockSession();assert.equal(source.closed,true);source.emit('documents',JSON.stringify({documentIds:['c']}));await settle();assert.equal(events.length,2);stop();resumeSession();
});
test('wrong identity or expired stream never refreshes private UI',async()=>{
 resumeSession();const source=new Source();let expired=0,changes=0;
 const stop=startChangeFeed({create:()=>source,verify:async()=>false,changed:()=>changes++,expired:()=>expired++});
 source.emit('ready');await settle();assert.equal(expired,1);assert.equal(changes,0);assert.equal(source.closed,true);source.emit('session-expired');assert.equal(expired,1);stop();
});
test('late verification after cleanup cannot dispatch',async()=>{
 resumeSession();const source=new Source();let resolve!:(value:boolean)=>void;let calls=0;
 const stop=startChangeFeed({create:()=>source,verify:()=>new Promise(done=>{resolve=done;}),changed:()=>calls++,expired:()=>calls++});source.emit('ready');stop();resolve(true);await settle();assert.equal(calls,0);
});
test('connection failure fences late ready verification and reconnect revalidates everything',async()=>{
 resumeSession();const sources:Source[]=[];const checks:((value:boolean)=>void)[]=[];let changes=0;
 const stop=startChangeFeed({create:()=>{const source=new Source();sources.push(source);return source;},verify:()=>new Promise(resolve=>checks.push(resolve)),changed:()=>changes++,expired:()=>assert.fail('unexpected expiry')});
 sources[0]!.emit('ready');sources[0]!.emit('error');checks[0]!(true);await settle();assert.equal(changes,0);
 checks[1]!(true);await new Promise(resolve=>setTimeout(resolve,1600));assert.equal(sources.length,2);
 sources[1]!.emit('ready');checks[2]!(true);await settle();assert.equal(changes,1);stop();assert.equal(sources[1]!.closed,true);
});
test('blocked sessions never create a stream',()=>{
 blockSession();const stop=startChangeFeed({create:()=>assert.fail('blocked stream opened'),verify:async()=>true,changed:()=>assert.fail('blocked dispatch'),expired:()=>assert.fail('blocked expiry')});stop();resumeSession();
});
