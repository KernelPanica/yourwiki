import './docs-formatting.css';
import {docsShell} from './docs-shell.js';
import {documentPages} from './document-pages.js';
import {Editor,Extension} from '@tiptap/core';
import {Plugin,PluginKey,TextSelection} from '@tiptap/pm/state';
import {Decoration,DecorationSet} from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import {TextStyleKit} from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import {TableKit} from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import {absolutePositionToRelativePosition,relativePositionToAbsolutePosition,ySyncPluginKey} from '@tiptap/y-tiptap';
import {t,Y,ydoc,boot,host,toolbar,button as sharedButton,select as sharedSelect,dialog,api,error,b64,unb64,holdUpdates,heldUpdate} from './shared.js';

export function richEditor(){
  let peers=[],presenceChange=()=>{};
  const presenceKey=new PluginKey('yourwikiPresence');
  const Presence=Extension.create({name:'yourwikiPresence',addProseMirrorPlugins(){return [new Plugin({key:presenceKey,props:{decorations(state){
    const binding=ySyncPluginKey.getState(state)?.binding;if(!binding)return DecorationSet.empty;
    const decorations=[];
    for(const peer of peers){
      if(peer.selection?.kind!=='text'||!/^#[0-9a-f]{6}$/i.test(peer.color||''))continue;
      try{
        const positions=['anchor','head'].map(key=>relativePositionToAbsolutePosition(ydoc,binding.type,Y.decodeRelativePosition(unb64(peer.selection[key])),binding.mapping));
        if(positions.some(pos=>pos==null||pos<0||pos>state.doc.content.size))continue;
        const [anchor,head]=positions,from=Math.min(anchor,head),to=Math.max(anchor,head);
        if(from!==to)decorations.push(Decoration.inline(from,to,{class:'remote-presence-selection',style:`background-color:${peer.color}33`, 'data-presence-id':peer.id}));
        decorations.push(Decoration.widget(head,()=>{const cursor=document.createElement('span');cursor.className='remote-presence-cursor';cursor.dataset.presenceId=peer.id;cursor.style.cssText=`border-left:2px solid ${peer.color};position:relative;pointer-events:none;`;const label=document.createElement('span');label.textContent=peer.name||'';label.style.cssText=`position:absolute;left:-2px;bottom:1.2em;background:${peer.color};color:white;padding:1px 4px;font-size:11px;white-space:nowrap;`;cursor.append(label);return cursor;},{key:peer.id,side:1}));
      }catch{/* A deleted relative anchor has no visible cursor. */}
    }
    return DecorationSet.create(state.doc,decorations);
  }}})];}});
  host.classList.add('document-host');
  toolbar.classList.add('document-toolbar-ribbon');
  let activeGroup=toolbar;
  const group=(label,tab='home')=>{
    const section=document.createElement('section');section.className='document-tool-group';section.setAttribute('role','group');section.setAttribute('aria-label',t(label));
    section.dataset.tab=tab;
    section.dataset.group=label;
    const controls=document.createElement('div');controls.className='document-tool-controls';
    const caption=document.createElement('span');caption.className='document-tool-caption';caption.textContent=t(label);
    section.append(controls,caption);toolbar.append(section);activeGroup=controls;
  };
  const button=(label,action,options={})=>sharedButton(label,action,{...options,parent:options.parent||activeGroup});
  const select=(label,values,action)=>sharedSelect(label,values,action,activeGroup);
  const SizedImage=Image.extend({addAttributes(){return {...this.parent?.(),width:{default:null,parseHTML:el=>el.getAttribute('width'),renderHTML:attrs=>attrs.width?{width:attrs.width}:{}}};}});
  const DocumentNavigation=Extension.create({name:'documentNavigation',addKeyboardShortcuts(){
    // Native document navigation can leave a stale model selection next to a
    // noneditable presence cursor. Move the model and DOM selection together.
    const move=(end,extend=false)=>{const state=this.editor.state;const target=end?TextSelection.atEnd(state.doc):TextSelection.atStart(state.doc);return this.editor.chain().setTextSelection(extend?{from:state.selection.anchor,to:target.head}:target.head).scrollIntoView().run();};
    return {'Mod-End':()=>move(true),'Mod-Home':()=>move(false),'Mod-Shift-End':()=>move(true,true),'Mod-Shift-Home':()=>move(false,true)};
  }});
  const ParagraphSpacing=Extension.create({name:'paragraphSpacing',addGlobalAttributes(){return [{types:['paragraph','heading'],attributes:{lineHeight:{default:null,parseHTML:el=>el.style.lineHeight||null,renderHTML:attrs=>attrs.lineHeight?{style:`line-height:${attrs.lineHeight}`}:{}}}}];}});
  const CellFill=Extension.create({name:'cellFill',addGlobalAttributes(){return [{types:['tableCell','tableHeader'],attributes:{backgroundColor:{default:null,parseHTML:el=>el.style.backgroundColor||null,renderHTML:attrs=>attrs.backgroundColor?{style:`background-color:${attrs.backgroundColor}`}:{}}}}];}});
  const editor=new Editor({element:host,editable:boot.write,extensions:[StarterKit.configure({undoRedo:false,link:{openOnClick:false}}),Collaboration.configure({document:ydoc,field:'content'}),Presence,DocumentNavigation,documentPages(t),TextStyleKit,ParagraphSpacing,TextAlign.configure({types:['heading','paragraph']}),SizedImage,CellFill,TableKit.configure({table:{resizable:true}}),Highlight.configure({multicolor:true})],editorProps:{attributes:{'aria-label':t('Document content'),role:'textbox','aria-multiline':'true'}}});
  editor.getPresenceSelection=()=>{
    const binding=ySyncPluginKey.getState(editor.state)?.binding;if(!binding)return null;
    const selection=window.getSelection();let positions=editor.state.selection;
    if(selection?.anchorNode&&selection.focusNode&&editor.view.dom.contains(selection.anchorNode)&&editor.view.dom.contains(selection.focusNode)){
      positions={anchor:editor.view.posAtDOM(selection.anchorNode,selection.anchorOffset),head:editor.view.posAtDOM(selection.focusNode,selection.focusOffset)};
    }else if(!editor.isFocused)return null;
    return {kind:'text',...Object.fromEntries(['anchor','head'].map(key=>[key,b64(Y.encodeRelativePosition(absolutePositionToRelativePosition(positions[key],binding.type,binding.mapping)))]))};
  };
  editor.renderPresence=entries=>{peers=entries;editor.view.dispatch(editor.state.tr.setMeta(presenceKey,true));};
  editor.setPresenceChange=callback=>{presenceChange=callback;};
  editor.on('selectionUpdate',()=>presenceChange());editor.on('focus',()=>presenceChange());editor.on('blur',()=>presenceChange());
  const selectionChanged=()=>presenceChange();document.addEventListener('selectionchange',selectionChanged);
  editor.on('destroy',()=>document.removeEventListener('selectionchange',selectionChanged));
  group('Editing');const editingControls=activeGroup;button('Undo',()=>editor.commands.undo());button('Redo',()=>editor.commands.redo());
  group('Formatting');
  const styleControl=select('Style',[['0','Paragraph'],...[1,2,3,4,5,6].map(level=>[String(level),`Heading ${level}`])],v=>v==='0'?editor.chain().focus().setParagraph().run():editor.chain().focus().setHeading({level:Number(v)}).run());
  const fonts=['Arial','Calibri','Cambria','Comic Sans MS','Courier New','Georgia','Helvetica','Tahoma','Times New Roman','Trebuchet MS','Verdana','monospace','sans-serif','serif'];
  const fontControl=select('Font',fonts.map(v=>[v,v]),v=>editor.chain().focus().setFontFamily(v).run());
  for(const option of fontControl.options)option.style.fontFamily=option.value;
  const sizeControl=select('Size',[8,9,10,11,12,14,16,18,20,24,28,32,36,48,72].map(v=>[`${v}pt`,String(v)]),v=>editor.chain().focus().setFontSize(v).run());
  const setControl=(control,value)=>{
    // Preserve imported sizes and fonts rather than showing an unrelated default.
    for(const option of [...control.options])if(option.dataset.current)option.remove();
    if(value&&![...control.options].some(option=>option.value===value)){const option=new Option(value,value);option.dataset.current='';control.add(option);}
    control.value=value;
  };
  const toggles=[['Bold','bold','toggleBold'],['Italic','italic','toggleItalic'],['Underline','underline','toggleUnderline'],['Strike','strike','toggleStrike']];
  const toggleControls=[];
  for(const [label,mark,command] of toggles){const el=button(label,()=>editor.chain().focus()[command]().run());toggleControls.push([el,mark]);}
  const colorControls=[];
  for(const [label,command] of [['Text color','setColor'],['Highlight','setHighlight']]){const wrap=document.createElement('label');wrap.className='toolbar-label';wrap.textContent=t(label);const input=document.createElement('input');input.type='color';input.value=label==='Highlight'?'#ffff88':'#111827';input.setAttribute('aria-label',t(label));input.dataset.write='';input.disabled=!boot.write;input.oninput=()=>editor.chain().focus()[command](command==='setHighlight'?{color:input.value}:input.value).run();wrap.append(input);activeGroup.append(wrap);colorControls.push([input,command]);}
  button('Clear formatting',()=>editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().updateAttributes('paragraph',{lineHeight:null}).run());
  group('Paragraph');
  const alignControl=select('Align',[['left','Left'],['center','Center'],['right','Right'],['justify','Justify']],v=>editor.chain().focus().setTextAlign(v).run());
  for(const [label,mark,command] of [['Bullet list','bulletList','toggleBulletList'],['Numbered list','orderedList','toggleOrderedList'],['Quote','blockquote','toggleBlockquote']]){const el=button(label,()=>editor.chain().focus()[command]().run());toggleControls.push([el,mark]);}
  const spacingControl=select('Line spacing',[['1','Single'],['1.15','1.15'],['1.5','1.5'],['2','Double']],v=>editor.chain().focus().updateAttributes('paragraph',{lineHeight:v}).updateAttributes('heading',{lineHeight:v}).run());
  const indent=button('Increase indent',()=>editor.chain().focus().sinkListItem('listItem').run());
  const outdent=button('Decrease indent',()=>editor.chain().focus().liftListItem('listItem').run());
  const reflect=()=>{
    const attrs=editor.getAttributes('textStyle');setControl(fontControl,attrs.fontFamily||'Arial');setControl(sizeControl,attrs.fontSize||'12pt');
    styleControl.value=String(editor.isActive('heading')?editor.getAttributes('heading').level:0);
    spacingControl.value=String(editor.getAttributes(editor.isActive('heading')?'heading':'paragraph').lineHeight||'1.5');
    alignControl.value=editor.getAttributes(editor.isActive('heading')?'heading':'paragraph').textAlign||'left';
    for(const [el,mark] of toggleControls)el.setAttribute('aria-pressed',String(editor.isActive(mark)));
    indent.disabled=!boot.write||!editor.can().sinkListItem('listItem');outdent.disabled=!boot.write||!editor.can().liftListItem('listItem');
    for(const [input,command] of colorControls){const value=command==='setColor'?attrs.color:editor.getAttributes('highlight').color;if(/^#[0-9a-f]{6}$/i.test(value||''))input.value=value;}
  };
  editor.on('selectionUpdate',reflect);editor.on('transaction',reflect);reflect();
  group('Insert','insert');
  button('Link',async()=>{const d=await dialog('Insert link',[['url','URL','https://','url']]);if(d&&/^(https?:|mailto:)/.test(d.url))editor.chain().focus().extendMarkRange('link').setLink({href:d.url}).run();});
  button('Remove link',()=>editor.chain().focus().extendMarkRange('link').unsetLink().run());
  button('Table',()=>editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run());
  const tableActions=select('Table actions',[['','Choose…'],['addRowBefore','Add row before'],['addRowAfter','Add row'],['addColumnBefore','Add column before'],['addColumnAfter','Add column'],['deleteRow','Delete row'],['deleteColumn','Delete column'],['mergeCells','Merge cells'],['splitCell','Split cell'],['toggleHeaderRow','Header row'],['toggleHeaderColumn','Header column'],['deleteTable','Delete table']],v=>{if(v){editor.chain().focus()[v]().run();tableActions.value='';}});
  const fillLabel=document.createElement('label');fillLabel.className='toolbar-label';fillLabel.textContent=t('Cell background');
  const cellFill=document.createElement('input');cellFill.type='color';cellFill.value='#ffffff';cellFill.setAttribute('aria-label',t('Cell background'));cellFill.dataset.write='';cellFill.oninput=()=>editor.chain().focus().setCellAttribute('backgroundColor',cellFill.value).run();fillLabel.append(cellFill);activeGroup.append(fillLabel);
  const clearCellFill=button('Clear cell background',()=>editor.chain().focus().setCellAttribute('backgroundColor',null).run());
  const reflectTable=()=>{const inTable=editor.isActive('table');tableActions.disabled=!boot.write||!inTable;cellFill.disabled=!boot.write||!inTable;clearCellFill.disabled=!boot.write||!inTable;for(const option of tableActions.options)if(option.value)option.disabled=!editor.can()[option.value]();const color=editor.getAttributes(editor.isActive('tableHeader')?'tableHeader':'tableCell').backgroundColor;cellFill.value=/^#[0-9a-f]{6}$/i.test(color||'')?color:'#ffffff';};
  editor.on('transaction',reflectTable);reflectTable();
  button('Image',()=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.onchange=async()=>{try{const form=new FormData();form.append('file',input.files[0]);const result=await api(`/api/docs/${boot.id}/attachments`,{method:'POST',body:form});const d=await dialog('Image description',[['alt','Alternative text']]);editor.chain().focus().setImage({src:result.url,alt:d?.alt||''}).run();}catch(e){error(e.message);}};input.click();});
  button('Resize image',async()=>{if(!editor.isActive('image'))throw new Error(t('Select an image first.'));const d=await dialog('Image width',[['width','Width in pixels','400','number']]);if(d){const width=Number(d.width);if(width<16||width>2000)throw new Error(t('Use a width between 16 and 2000 pixels.'));editor.chain().focus().updateAttributes('image',{width}).run();}});
  activeGroup=editingControls;
  button('Find / replace',async()=>{const d=await dialog('Find and replace',[['find','Find'],['replace','Replace with']]);if(!d?.find)return;const found=[];editor.state.doc.descendants((node,pos)=>{if(!node.isText)return;let start=0,index;while((index=node.text.indexOf(d.find,start))!==-1){found.push([pos+index,pos+index+d.find.length]);start=index+d.find.length;}});if(!found.length)throw new Error(t('No matching text.'));const tr=editor.state.tr;for(const [from,to] of found.reverse())tr.insertText(d.replace,from,to);editor.view.dispatch(tr);});
  docsShell(editor);
  const anchor=()=>{const binding=ySyncPluginKey.getState(editor.state).binding;const {from,to}=editor.state.selection;return {start:Y.relativePositionToJSON(absolutePositionToRelativePosition(from,binding.type,binding.mapping)),end:Y.relativePositionToJSON(absolutePositionToRelativePosition(to,binding.type,binding.mapping)),quote:editor.state.doc.textBetween(from,to)};};
  let selectedAnchor=null;editor.on('selectionUpdate',()=>{selectedAnchor=anchor();});
  async function add(kind){try{await api(`/api/docs/${boot.id}/reviews`,{method:'POST',body:JSON.stringify({kind,body:document.getElementById('review-body').value,anchor:selectedAnchor||anchor()})});document.getElementById('review-body').value='';await refresh();}catch(e){error(e.message);}}
  document.getElementById('add-comment').onclick=()=>add('comment');document.getElementById('add-suggestion').onclick=()=>add('suggestion');
  const positions=a=>{const binding=ySyncPluginKey.getState(editor.state).binding;return [a.start,a.end].map(p=>relativePositionToAbsolutePosition(ydoc,binding.type,Y.createRelativePositionFromJSON(p),binding.mapping));};
  let reviewSignature='';
  async function refresh(){
    const reviews=await api(`/api/docs/${boot.id}/reviews`);const signature=JSON.stringify(reviews)+boot.write;if(signature===reviewSignature)return;reviewSignature=signature;
    const list=document.getElementById('review-list');list.replaceChildren();
    for(const review of reviews){const card=document.createElement('article');card.className='review-card';const meta=document.createElement('small');meta.textContent=`${review.author} · ${t(review.kind)} · ${t(review.status)}`;const body=document.createElement('p');body.textContent=review.body||t('(Delete selected text)');card.append(meta,body);
      if(review.anchor.start)button('Show text',()=>{const [from,to]=positions(review.anchor);if(from==null||to==null)throw new Error(t('The original text no longer exists.'));editor.commands.setTextSelection({from,to});editor.commands.focus();},{write:false,parent:card});
      if(boot.write&&review.status==='open')for(const action of review.kind==='suggestion'?['accept','reject']:['resolve'])button(action,async()=>{
        let update;
        if(action==='accept'){
          const [from,to]=positions(review.anchor);if(from==null||to==null||editor.state.doc.textBetween(from,to)!==review.anchor.quote)throw new Error(t('The selected text changed. Review the current text before making a new suggestion.'));
          holdUpdates(true);editor.view.dispatch(editor.state.tr.insertText(review.body,from,to));update=b64(heldUpdate());
        }
        try{await api(`/api/docs/${boot.id}/reviews/${review.id}`,{method:'POST',body:JSON.stringify({action,update})});}
        catch(e){if(action==='accept')location.reload();throw e;}
        finally{holdUpdates(false);}
        await refresh();
      },{parent:card});list.append(card);
    }
  }
  refresh().catch(e=>error(e.message));setInterval(()=>refresh().catch(()=>{}),3000);
  return editor;
}
