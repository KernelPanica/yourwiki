import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import {TextStyleKit} from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import {TableKit} from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import {absolutePositionToRelativePosition,relativePositionToAbsolutePosition,ySyncPluginKey} from '@tiptap/y-tiptap';
import {t,Y,ydoc,boot,host,toolbar,button as sharedButton,select as sharedSelect,dialog,api,error,b64,holdUpdates,heldUpdate} from './shared.js';

export function richEditor(){
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
  const editor=new Editor({element:host,editable:boot.write,extensions:[StarterKit.configure({undoRedo:false,link:{openOnClick:false}}),Collaboration.configure({document:ydoc,field:'content'}),TextStyleKit,TextAlign.configure({types:['heading','paragraph']}),SizedImage,TableKit.configure({table:{resizable:true}}),Highlight.configure({multicolor:true})],editorProps:{attributes:{'aria-label':t('Document content'),role:'textbox','aria-multiline':'true'}}});
  group('Editing');const editingControls=activeGroup;button('Undo',()=>editor.commands.undo());button('Redo',()=>editor.commands.redo());
  group('Formatting');
  const styleControl=select('Style',[['0','Paragraph'],['1','Heading 1'],['2','Heading 2'],['3','Heading 3']],v=>v==='0'?editor.chain().focus().setParagraph().run():editor.chain().focus().toggleHeading({level:Number(v)}).run());
  const fontControl=select('Font',['Arial','Georgia','Verdana','monospace','sans-serif','serif'].map(v=>[v,v]),v=>editor.chain().focus().setFontFamily(v).run());
  const sizeControl=select('Size',[10,12,14,16,18,20,24,32,48,72].map(v=>[String(v),String(v)]),v=>editor.chain().focus().setFontSize(`${v}px`).run());
  const reflect=()=>{const attrs=editor.getAttributes('textStyle');fontControl.value=attrs.fontFamily||'sans-serif';sizeControl.value=String(parseInt(attrs.fontSize||'16'));styleControl.value=String(editor.isActive('heading')?editor.getAttributes('heading').level:0);};editor.on('selectionUpdate',reflect);editor.on('transaction',reflect);reflect();
  const toggles=[['Bold','bold','toggleBold'],['Italic','italic','toggleItalic'],['Underline','underline','toggleUnderline'],['Strike','strike','toggleStrike']];
  for(const [label,mark,command] of toggles){const el=button(label,()=>editor.chain().focus()[command]().run());editor.on('transaction',()=>el.setAttribute('aria-pressed',String(editor.isActive(mark))));}
  for(const [label,command] of [['Text color','setColor'],['Highlight','setHighlight']]){const wrap=document.createElement('label');wrap.className='toolbar-label';wrap.textContent=t(label);const input=document.createElement('input');input.type='color';input.value=label==='Highlight'?'#ffff88':'#111827';input.setAttribute('aria-label',t(label));input.dataset.write='';input.disabled=!boot.write;input.oninput=()=>editor.chain().focus()[command](command==='setHighlight'?{color:input.value}:input.value).run();wrap.append(input);activeGroup.append(wrap);}
  group('Paragraph');
  select('Align',['left','center','right','justify'].map(v=>[v,v]),v=>editor.chain().focus().setTextAlign(v).run());
  button('Bullet list',()=>editor.chain().focus().toggleBulletList().run());button('Numbered list',()=>editor.chain().focus().toggleOrderedList().run());
  group('Insert','insert');
  button('Link',async()=>{const d=await dialog('Insert link',[['url','URL','https://','url']]);if(d&&/^(https?:|mailto:)/.test(d.url))editor.chain().focus().setLink({href:d.url}).run();});
  button('Table',()=>editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run());
  select('Table actions',[['','Choose…'],['addRowAfter','Add row'],['addColumnAfter','Add column'],['deleteRow','Delete row'],['deleteColumn','Delete column'],['mergeCells','Merge cells'],['splitCell','Split cell'],['deleteTable','Delete table']],v=>{if(v)editor.chain().focus()[v]().run();});
  button('Image',()=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.onchange=async()=>{try{const form=new FormData();form.append('file',input.files[0]);const result=await api(`/api/docs/${boot.id}/attachments`,{method:'POST',body:form});const d=await dialog('Image description',[['alt','Alternative text']]);editor.chain().focus().setImage({src:result.url,alt:d?.alt||''}).run();}catch(e){error(e.message);}};input.click();});
  button('Resize image',async()=>{if(!editor.isActive('image'))throw new Error(t('Select an image first.'));const d=await dialog('Image width',[['width','Width in pixels','400','number']]);if(d){const width=Number(d.width);if(width<16||width>2000)throw new Error(t('Use a width between 16 and 2000 pixels.'));editor.chain().focus().updateAttributes('image',{width}).run();}});
  activeGroup=editingControls;
  button('Find / replace',async()=>{const d=await dialog('Find and replace',[['find','Find'],['replace','Replace with']]);if(!d?.find)return;const found=[];editor.state.doc.descendants((node,pos)=>{if(!node.isText)return;let start=0,index;while((index=node.text.indexOf(d.find,start))!==-1){found.push([pos+index,pos+index+d.find.length]);start=index+d.find.length;}});if(!found.length)throw new Error(t('No matching text.'));const tr=editor.state.tr;for(const [from,to] of found.reverse())tr.insertText(d.replace,from,to);editor.view.dispatch(tr);});
  const tabs=document.createElement('div');tabs.className='document-ribbon-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('Formatting'));
  const panel=document.createElement('div');panel.id='document-ribbon-panel';panel.setAttribute('role','tabpanel');
  toolbar.before(tabs,panel);panel.append(toolbar);
  const tabButtons=[];
  function activate(index){
    tabButtons.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});
    toolbar.querySelectorAll('[data-tab]').forEach(section=>section.hidden=section.dataset.tab!==tabButtons[index].dataset.tab);
    panel.setAttribute('aria-labelledby',tabButtons[index].id);
  }
  for(const [key,label] of [['home','Home'],['insert','Insert']]){
    const tab=document.createElement('button');tab.type='button';tab.className='document-ribbon-tab';tab.id='document-tab-'+key;tab.dataset.tab=key;tab.textContent=t(label);tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);
    const index=tabButtons.length;tab.onmousedown=event=>event.preventDefault();tab.onclick=()=>activate(index);
    tab.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabButtons.length;else if(event.key==='ArrowLeft')next=(index+tabButtons.length-1)%tabButtons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabButtons.length-1;else return;event.preventDefault();activate(next);tabButtons[next].focus();};
    tabButtons.push(tab);tabs.append(tab);
  }
  activate(0);
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
