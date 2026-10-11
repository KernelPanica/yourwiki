import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {translateNodes,positionedNodes,anchoredZoom} from '../../frontend/canvas-geometry.js';
import {diagramTree,preserveEnvelope} from '../../frontend/diagram-xml.js';

test('concurrent movement operations combine once through Yjs',()=>{
  const seed=new Y.Doc();seed.getMap('moves');
  const clients=[new Y.Doc(),new Y.Doc()];
  const base={nodes:{n:{id:'n',x:10,y:20,custom:'kept'}}};
  clients.forEach((client,i)=>{
    Y.applyUpdate(client,Y.encodeStateAsUpdate(seed));
    const data=structuredClone(base);translateNodes(data,['n'],i?7:3,i?-4:2,`move-${i}`);
    for(const [id,value] of Object.entries(data.translations.n))client.getMap('moves').set(id,value);
  });
  const updates=clients.map(client=>Y.encodeStateAsUpdate(client));
  for(const client of clients){for(const update of [...updates,...updates])Y.applyUpdate(client,update);
    assert.deepEqual(positionedNodes({...base,translations:{n:client.getMap('moves').toJSON()}}).n,{id:'n',x:20,y:18,custom:'kept'});
  }
});

test('zoom retains the world point beneath the pointer',()=>{
  const before={x:75,y:90},point={x:400,y:300};
  const {pan,zoom}=anchoredZoom(before,2,3,point);
  assert.equal((point.x-pan.x)/zoom,(point.x-before.x)/2);
  assert.equal((point.y-pan.y)/zoom,(point.y-before.y)/2);
});

test('diagram envelopes retain extension content without resurrecting deleted cells',()=>{
  const ext={tag:'{urn:extension}meta',attrs:{flag:'yes'},text:'before',children:[{tag:'{urn:extension}child',attrs:{},tail:'after'}]};
  const data={order:['p'],xml:{tag:'mxfile',attrs:{host:'offline'},children:[ext,{slot:'page',id:'p'}]},pages:{p:{name:'Page',attrs:{grid:'1'},cells:{'0':{tag:'mxCell',attrs:{id:'0'}}},root:{tag:'root',attrs:{custom:'yes'},children:[{slot:'cell',id:'0'},{slot:'cell',id:'deleted'},ext]}}}};
  const tree=diagramTree(data);
  assert.deepEqual(tree.children[0],ext);
  const root=tree.children[1].children[0].children[0];
  assert.equal(root.attrs.custom,'yes');assert.equal(root.children.length,2);
  const preserved=preserveEnvelope(data.xml,{tag:'mxfile',attrs:{host:'new'},children:[{slot:'page',id:'p'}]});
  assert.equal(preserved.attrs.host,'new');assert.deepEqual(preserved.children[0],ext);
});

test('Obsidian sides and enclosed group cards retain geometry',async()=>{
  const {connectionGeometry,groupSelection}=await import('../../frontend/canvas-geometry.js');
  const nodes={g:{id:'g',type:'group',x:0,y:0,width:500,height:500},a:{id:'a',x:20,y:20,width:100,height:100},b:{id:'b',x:800,y:20,width:100,height:100}};
  assert.deepEqual(groupSelection(nodes,['g']),['g','a']);
  assert.match(connectionGeometry(nodes.a,nodes.b,{fromSide:'right',toSide:'left'}).path,/^M120,70 C/);
  assert.match(connectionGeometry(nodes.a,nodes.b,{fromSide:'right',toSide:'left'}).path,/800,70$/);
});
