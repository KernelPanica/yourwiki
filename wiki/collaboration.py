"""Durable Yjs-compatible collaboration, with server-derived snapshots."""
from .storage import file_limit_bytes, auxiliary_limit_bytes
import base64
import csv
import io
import json
import logging
import secrets
from html.parser import HTMLParser
from xml.etree.ElementTree import Element, SubElement, tostring
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from pycrdt import Doc, Map, XmlFragment, XmlElement, XmlText
from .models import Collaboration, Document, Review
from .native import pack, unpack
from .services import require, validate_content
from .storage import active_storage

log = logging.getLogger('wiki')


class MarkdownTree(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = {'type': 'doc', 'content': []}
        self.stack = [self.root]
        self.marks = []

    def handle_starttag(self, tag, attrs):
        marks = {'strong':'bold','em':'italic','code':'code','a':'link'}
        if tag in marks:
            self.marks.append({'type': marks[tag], 'attrs': dict(attrs)})
            return
        types = {'p':'paragraph','ul':'bulletList','ol':'orderedList','li':'listItem','blockquote':'blockquote','pre':'codeBlock','table':'table','tr':'tableRow','td':'tableCell','th':'tableHeader','hr':'horizontalRule','br':'hardBreak'}
        if tag not in types and tag not in ('h1','h2','h3','h4','h5','h6'):
            return
        node = {'type': types.get(tag, 'heading'), 'content': []}
        if tag.startswith('h') and tag[1:].isdigit():
            node['attrs'] = {'level': int(tag[1:])}
        self.stack[-1]['content'].append(node)
        if tag not in ('hr','br'):
            self.stack.append(node)

    def handle_endtag(self, tag):
        if tag in ('strong','em','code','a'):
            if self.marks: self.marks.pop()
        elif tag not in ('thead','tbody','hr','br') and len(self.stack) > 1:
            self.stack.pop()

    def handle_data(self, value):
        if value.strip() or self.stack[-1]['type'] in ('paragraph','heading','codeBlock'):
            self.stack[-1]['content'].append({'type':'text','text':value,'marks':list(self.marks)})


def xml_node(node):
    if node['type'] == 'text':
        return XmlText(node.get('text', ''))
    return XmlElement(node['type'], attributes=node.get('attrs', {}), contents=[xml_node(n) for n in node.get('content', [])])


def normalize_tree(node):
    children=node.get('content',[])
    if node.get('type') in ('doc','listItem','tableCell','tableHeader'):
        blocks=[];inline=[]
        for child in children:
            if child.get('type') in ('text','hardBreak'):
                inline.append(child)
            else:
                if inline:blocks.append({'type':'paragraph','content':inline});inline=[]
                blocks.append(child)
        if inline:blocks.append({'type':'paragraph','content':inline})
        node['content']=blocks or [{'type':'paragraph'}]
    for child in node.get('content',[]):normalize_tree(child)


def apply_marks(xml, node):
    if node['type'] == 'text':
        marks = {m['type']: m.get('attrs') or {} for m in node.get('marks', [])}
        if marks and len(xml):
            xml.format(0, len(xml), marks)
    else:
        for x, n in zip(xml.children, node.get('content', [])):
            apply_marks(x, n)


def xml_json(xml, depth=0):
    if depth > 40:
        raise ValidationError('Document nesting is too deep.')
    if isinstance(xml, XmlText):
        return [{'type':'text','text':str(text), 'marks':[{'type': k.split('--')[0], 'attrs': v if isinstance(v,dict) else {}} for k,v in (marks or {}).items()]} for text,marks in xml.diff() if text]
    children = [n for child in xml.children for n in xml_json(child, depth+1)]
    if isinstance(xml, XmlFragment):
        return [{'type':'doc','content':children}]
    return [{'type': xml.tag, 'attrs': dict(xml.attributes), 'content': children}]


def flatten(value, path=()):
    if isinstance(value, dict) and value:
        for key, child in value.items():
            yield from flatten(child, (*path, str(key)))
    else:
        yield json.dumps(path, separators=(',', ':')), value


def unflatten(mapping):
    root = {}
    for key, value in mapping.items():
        path = json.loads(key)
        if not isinstance(path, list) or not path or len(path) > 40 or any(not isinstance(p, str) or p in ('__proto__','constructor','prototype') for p in path):
            raise ValidationError('Invalid shared object path.')
        target = root
        for segment in path[:-1]:
            if not isinstance(target.get(segment), dict):
                target[segment] = {}
            target = target[segment]
        target[path[-1]] = value
    return root


def diagram_data(text):
    import base64, zlib
    from urllib.parse import unquote
    root = diagram_parse(text)
    local = lambda element: element.tag.rsplit('}', 1)[-1] if isinstance(element.tag, str) else ''
    diagrams = [child for child in root if local(child) == 'diagram'] if local(root) == 'mxfile' else [root]
    data = {'pages':{}, 'order':[], 'xml':element_data(root)}
    for i, page in enumerate(diagrams):
        pid = page.get('id') or f'page-{i}'
        model = page if local(page) == 'mxGraphModel' else next((child for child in page if local(child) == 'mxGraphModel'), None)
        page_xml = element_data(page)
        if model is None and page.text:
            decoder = zlib.decompressobj(-15)
            raw = decoder.decompress(base64.b64decode(page.text), (file_limit_bytes() + 1) if file_limit_bytes() is not None else 0)
            if (file_limit_bytes() is not None and len(raw) > file_limit_bytes()) or not decoder.eof: raise ValidationError('Diagram is too large.')
            model = diagram_parse(unquote(raw.decode()))
            page_xml['text'] = None
            page_xml['children'].insert(0, {'slot':'model'})
        if model is None: raise ValidationError('Invalid diagram page.')
        graph_root = next((child for child in model if local(child) == 'root'), None)
        if graph_root is None: raise ValidationError('Invalid diagram root.')
        cells, order = {}, []
        root_xml = element_data(graph_root)
        for index, cell in enumerate(graph_root):
            nested = next((child for child in cell if local(child) == 'mxCell'), None)
            cid = cell.get('id') or (nested.get('id') if nested is not None else None)
            if cid:
                if cid in cells: raise ValidationError('Duplicate diagram cell identity.')
                cells[cid] = element_data(cell)
                order.append(cid)
                root_xml['children'][index] = {'slot':'cell', 'id':cid}
        model_xml = element_data(model)
        model_xml['children'][list(model).index(graph_root)] = {'slot':'root'}
        if page is model:
            page_xml = {'slot':'model'}
        else:
            for index, child in enumerate(page):
                if child is model: page_xml['children'][index] = {'slot':'model'}
        data['pages'][pid] = {'name':page.get('name', f'Page {i+1}'), 'attrs':dict(model.attrib), 'cells':cells,
                              'order':order, 'xml':page_xml, 'model':model_xml, 'root':root_xml}
        if pid in data['order']: raise ValidationError('Duplicate diagram page identity.')
        data['order'].append(pid)
        if page is root:
            data['xml'] = {'slot':'page', 'id':pid}
        else:
            data['xml']['children'][list(root).index(page)] = {'slot':'page', 'id':pid}
    return data


def diagram_parse(text):
    from xml.etree.ElementTree import fromstring, TreeBuilder
    from defusedxml.ElementTree import DefusedXMLParser
    return fromstring(text, parser=DefusedXMLParser(target=TreeBuilder(insert_comments=True, insert_pis=True)))


def element_data(element):
    from xml.etree.ElementTree import Comment, ProcessingInstruction
    tag = '#comment' if element.tag is Comment else '#pi' if element.tag is ProcessingInstruction else element.tag
    return {'tag':tag,'attrs':dict(element.attrib),'text':element.text,'tail':element.tail,'children':[element_data(c) for c in element]}


def data_element(value):
    if isinstance(value,str):
        return diagram_parse(value)
    from xml.etree.ElementTree import Comment, ProcessingInstruction
    tag = value['tag']
    element=Element(Comment if tag == '#comment' else ProcessingInstruction if tag == '#pi' else tag,
                    {k:str(v) for k,v in value.get('attrs',{}).items()})
    element.text,element.tail=value.get('text'),value.get('tail')
    for child in value.get('children',[]):element.append(data_element(child))
    return element


def diagram_xml(data):
    import copy
    def fill(template, slot, values, order):
        result = copy.deepcopy(template)
        children, used = [], set()
        for child in result.get('children', []):
            if child.get('slot') == slot:
                key = child.get('id', slot)
                if key in values:
                    children.append(copy.deepcopy(values[key])); used.add(key)
            else: children.append(child)
        children.extend(copy.deepcopy(values[key]) for key in order if key in values and key not in used)
        result['children'] = children
        return result
    pages = {}
    for pid in data.get('order', []):
        page = data.get('pages', {}).get(pid)
        if not page: continue
        cells = page.get('cells', {})
        order = page.get('order', []) + [key for key in cells if key not in page.get('order', [])]
        root = fill(page.get('root', {'tag':'root'}), 'cell', cells, order)
        model = fill(page.get('model', {'tag':'mxGraphModel'}), 'root', {'root':root}, ['root'])
        model['attrs'] = {**model.get('attrs', {}), **page.get('attrs', {})}
        template = page.get('xml', {'tag':'diagram'})
        if template.get('slot') == 'model':
            pages[pid] = model
        else:
            diagram = fill(template, 'model', {'model':model}, ['model'])
            diagram['attrs'] = {**diagram.get('attrs', {}), 'id':pid, 'name':page.get('name', 'Page')}
            pages[pid] = diagram
    template = data.get('xml', {'tag':'mxfile'})
    root = pages[template['id']] if template.get('slot') == 'page' else fill(template, 'page', pages, data.get('order', []))
    return tostring(data_element(root), encoding='unicode')


def derive(doc, kind):
    if kind == 'document':
        return pack(kind, xml_json(doc.get('content', type=XmlFragment))[0])
    data = unflatten(doc.get('objects', type=Map).to_py())
    if kind == 'canvas':
        from .graphics import canvas_nodes
        return json.dumps({**data.get('extra', {}), 'nodes':canvas_nodes(data), 'edges':list(data.get('edges', {}).values())})
    if kind == 'drawio':
        return diagram_xml(data)
    layout = data.pop('_layout', {})
    data['_axes'] = {}
    for sid, sheet in data.get('sheets', {}).items():
        if sid not in layout: continue
        axes = layout[sid]
        rows = sorted(axes['rows'], key=lambda k:(axes['rows'][k],k))
        cols = sorted(axes['cols'], key=lambda k:(axes['cols'][k],k))
        data['_axes'][sheet.get('name', sid)] = {'id':sid, 'rows':rows, 'cols':cols}
        ri,ci = {v:str(i) for i,v in enumerate(rows)},{v:str(i) for i,v in enumerate(cols)}
        sheet['cellData'] = {ri[r]:{ci[c]:v for c,v in values.items() if c in ci} for r,values in sheet.get('cellData',{}).items() if r in ri}
        sheet['rowCount'],sheet['columnCount'] = len(rows),len(cols)
    return pack(kind, data)


def seed(document, content):
    ydoc = Doc()
    native = unpack(content)
    if document.kind == 'document':
        if native:
            tree = native['data']
        else:
            from .previews import preview
            parser = MarkdownTree(); parser.feed(preview('document', content)['markdown'])
            tree = parser.root
            normalize_tree(tree)
        if not tree.get('content'):
            tree['content'] = [{'type':'paragraph'}]
        ydoc['content'] = XmlFragment([xml_node(n) for n in tree['content']])
        for x,n in zip(ydoc['content'].children, tree['content']): apply_marks(x,n)
    else:
        if document.kind == 'table':
            data = native['data'] if native else {'id':str(document.pk), 'name':document.title, 'appVersion':'0.25.1', 'locale':'enUS', 'sheetOrder':['sheet1'], 'styles':{}, 'sheets':{'sheet1':{'id':'sheet1','name':'Sheet 1','rowCount':200,'columnCount':26,'cellData':{str(r):{str(c):{'v':v} for c,v in enumerate(row)} for r,row in enumerate(csv.reader(io.StringIO(content)))}}}}
            data.pop('_axes', None)
            data['_layout'] = {}
            for sid,sheet in data['sheets'].items():
                data['_layout'][sid] = {'rows':{f'r{i}':i for i in range(max(sheet.get('rowCount',200),len(sheet.get('cellData',{}))))},'cols':{f'c{i}':i for i in range(sheet.get('columnCount',26))}}
                sheet['cellData'] = {f'r{r}':{f'c{c}':v for c,v in cells.items()} for r,cells in sheet.get('cellData',{}).items()}
        elif document.kind == 'canvas':
            value = json.loads(content)
            data = {'nodes':{n['id']:n for n in value.get('nodes', [])},'edges':{e['id']:e for e in value.get('edges', [])}, 'extra':{k:v for k,v in value.items() if k not in ('nodes','edges')}}
        else:
            data = diagram_data(content)
        ydoc['objects'] = Map(dict(flatten(data)))
    return ydoc


def ensure_room(document):
    # Remote reads and CRDT seeding must not hold SQLite's writer lock.
    from .source import check_available
    from .realtime import connections
    from .file_formats import decode
    from .services import Conflict
    document.refresh_from_db()
    if document.kind == 'file':
        raise ValidationError('Uploaded files do not have a collaborative editor.')
    check_available(document)
    room=Collaboration.objects.filter(document=document).first()
    if room and room.state and (room.sequence!=room.synced_sequence or connections.get(str(document.pk))):return room
    adapter=active_storage()
    raw=adapter.read(document.reference)
    fingerprint=adapter.fingerprint(document.reference,raw)
    if room and room.state and fingerprint==document.storage_digest:
        content,state,seeded=room.snapshot,bytes(room.state),None
    else:
        content=decode(document,raw)
        seeded=seed(document,content)
        state=seeded.get_update()
    with transaction.atomic():
        current=Document.objects.get(pk=document.pk)
        if (current.reference,current.storage_digest,current.revision)!=(document.reference,document.storage_digest,document.revision):
            raise Conflict('This document changed while opening. Reload the editor.')
        check_available(current)
        room=Collaboration.objects.filter(document=current).first()
        if room and room.state:
            if room.sequence!=room.synced_sequence or connections.get(str(current.pk)):return room
            if not current.storage_digest or fingerprint==current.storage_digest:return room
            room.delete()
            current.revision+=1
        if current.storage_digest!=fingerprint:
            current.storage_digest=fingerprint
            current.save(update_fields=['storage_digest','revision'])
        room,_=Collaboration.objects.get_or_create(document=current)
        if not room.state:
            room.state,room.snapshot=state,content
            if current.kind=='table':
                if seeded is None:
                    seeded=Doc();seeded.apply_update(state)
                room.saved_structure=unpack(derive(seeded,'table'))['data'].get('_axes',{})
            room.save()
        return room


def apply_update(user, document_id, encoded, review_id=None, *, generation=None):
    try:
        update = base64.b64decode(encoded, validate=True)
    except Exception:
        raise ValidationError('Invalid collaboration update.')
    if (auxiliary_limit_bytes(6*1024*1024, 3) is not None and len(update) > auxiliary_limit_bytes(6*1024*1024, 3)):
        raise ValidationError('Update is too large.')
    with transaction.atomic():
        document = Document.objects.get(pk=document_id)
        require(document, user, 'read'); require(document, user, 'write')
        from .source import check_available
        check_available(document)
        room = Collaboration.objects.get(document=document)
        if generation is not None and str(room.generation) != str(generation):
            from .services import Conflict
            raise Conflict('The original changed. Download your edits before reloading.')
        ydoc = Doc(); ydoc.apply_update(bytes(room.state)); ydoc.apply_update(update)
        snapshot = derive(ydoc, document.kind)
        from .models import SiteConfiguration
        validate_content(document.kind, snapshot, SiteConfiguration.current().document_limit_mb)
        state = ydoc.get_update()
        if (auxiliary_limit_bytes(12*1024*1024, 3) is not None and len(state) > auxiliary_limit_bytes(12*1024*1024, 3)):
            raise ValidationError('Collaboration history is too large. Export and reimport this document.')
        if review_id:
            review = Review.objects.get(pk=review_id, document=document, kind='suggestion', status='open')
            review.status, review.resolved_by = 'accepted', user
            review.save(update_fields=['status','resolved_by'])
        if state == bytes(room.state):
            return room.sequence
        room.state, room.snapshot = state, snapshot
        room.sequence += 1
        room.save()
        document.format_version = 1
        document.updated_at = timezone.now()
        document.revision += 1
        document.save(update_fields=['format_version','updated_at','revision'])
        from .saves import stage
        stage(document,user,snapshot,'collaboration',document.revision,sequence=room.sequence)
        return room.sequence


def flush_room(document_id):
    from .models import SaveSession
    from .saves import stage, commit
    with transaction.atomic():
        room = Collaboration.objects.select_related('document__owner').filter(document_id=document_id).first()
        if not room or room.sequence <= room.synced_sequence:
            return
        session=SaveSession.objects.filter(document_id=document_id,client_id='collaboration').first()
        if not session:
            # Upgrade a pre-SaveSession room without discarding its pending state.
            session=stage(room.document,room.document.owner,room.snapshot,'collaboration',room.document.revision,sequence=room.sequence)
    return commit(session.pk,adapter=active_storage())


def current_content(document, *, cached=False):
    document = Document.objects.get(pk=document.pk)
    room = Collaboration.objects.filter(document=document).first()
    if room and room.snapshot and room.sequence != room.synced_sequence:
        return room.snapshot
    def load():
        from .file_formats import decode
        adapter=active_storage()
        # Remote I/O does not acquire SQLite's global IMMEDIATE writer lock.
        raw=adapter.read(document.reference)
        result=decode(document,raw)
        if not document.storage_digest:
            Document.objects.filter(pk=document.pk,reference=document.reference,storage_digest='').update(storage_digest=adapter.fingerprint(document.reference,raw))
        return result
    if cached:
        from .preview_cache import content
        return content(document,load)
    return load()
