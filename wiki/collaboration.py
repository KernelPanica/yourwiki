"""Durable Yjs-compatible collaboration, with server-derived snapshots."""
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
    from defusedxml.ElementTree import fromstring
    root = fromstring(text)
    diagrams = list(root.findall('diagram')) if root.tag == 'mxfile' else [root]
    data = {'pages':{}, 'order':[]}
    for i, page in enumerate(diagrams):
        pid = page.get('id') or f'page-{i}'
        model = page if page.tag == 'mxGraphModel' else page.find('mxGraphModel')
        if model is None and page.text:
            decoder = zlib.decompressobj(-15)
            raw = decoder.decompress(base64.b64decode(page.text), 5*1024*1024+1)
            if len(raw) > 5*1024*1024 or not decoder.eof: raise ValidationError('Diagram is too large.')
            model = fromstring(unquote(raw.decode()))
        if model is None: raise ValidationError('Invalid diagram page.')
        cells = {}
        for cell in model.find('root'):
            cid = cell.get('id') or (cell.find('mxCell').get('id') if cell.find('mxCell') is not None else secrets.token_hex(8))
            cells[cid] = element_data(cell)
        data['pages'][pid] = {'name':page.get('name', f'Page {i+1}'), 'attrs':dict(model.attrib), 'cells':cells}
        data['order'].append(pid)
    return data


def element_data(element):
    return {'tag':element.tag,'attrs':dict(element.attrib),'text':element.text,'tail':element.tail,'children':[element_data(c) for c in element]}


def data_element(value):
    if isinstance(value,str):
        from defusedxml.ElementTree import fromstring
        return fromstring(value)
    element=Element(value['tag'],{k:str(v) for k,v in value.get('attrs',{}).items()})
    element.text,element.tail=value.get('text'),value.get('tail')
    for child in value.get('children',[]):element.append(data_element(child))
    return element


def diagram_xml(data):
    from defusedxml.ElementTree import fromstring
    root = Element('mxfile')
    for pid in data.get('order', []):
        page = data.get('pages', {}).get(pid)
        if not page: continue
        diagram = SubElement(root, 'diagram', {'id': pid, 'name': page.get('name', 'Page')})
        model = SubElement(diagram, 'mxGraphModel', {k:str(v) for k,v in page.get('attrs', {}).items()})
        cells = SubElement(model, 'root')
        for cid, value in sorted(page.get('cells', {}).items(), key=lambda pair: (pair[0] not in ('0','1'), pair[0])):
            cells.append(data_element(value))
    return tostring(root, encoding='unicode')


def derive(doc, kind):
    if kind == 'document':
        return pack(kind, xml_json(doc.get('content', type=XmlFragment))[0])
    data = unflatten(doc.get('objects', type=Map).to_py())
    if kind == 'canvas':
        return json.dumps({**data.get('extra', {}), 'nodes':list(data.get('nodes', {}).values()), 'edges':list(data.get('edges', {}).values())})
    if kind == 'drawio':
        return diagram_xml(data)
    layout = data.pop('_layout', {})
    for sid, sheet in data.get('sheets', {}).items():
        if sid not in layout: continue
        axes = layout[sid]
        rows = sorted(axes['rows'], key=lambda k:(axes['rows'][k],k))
        cols = sorted(axes['cols'], key=lambda k:(axes['cols'][k],k))
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
    if document.kind == 'file':
        raise ValidationError('Uploaded files do not have a collaborative editor.')
    from .source import check_available
    check_available(document)
    room = Collaboration.objects.filter(document=document).first()
    if room and room.state:
        return room
    content = active_storage().read(document.reference).decode()
    state = seed(document, content).get_update()
    with transaction.atomic():
        room, _ = Collaboration.objects.get_or_create(document=document)
        if not room.state:
            room.state, room.snapshot = state, content
            room.save()
    return room


def apply_update(user, document_id, encoded, review_id=None):
    try:
        update = base64.b64decode(encoded, validate=True)
    except Exception:
        raise ValidationError('Invalid collaboration update.')
    if len(update) > 6*1024*1024:
        raise ValidationError('Update is too large.')
    with transaction.atomic():
        document = Document.objects.get(pk=document_id)
        require(document, user, 'read'); require(document, user, 'write')
        from .source import check_available
        check_available(document)
        room = Collaboration.objects.get(document=document)
        ydoc = Doc(); ydoc.apply_update(bytes(room.state)); ydoc.apply_update(update)
        snapshot = derive(ydoc, document.kind)
        from .models import SiteConfiguration
        validate_content(document.kind, snapshot, SiteConfiguration.current().document_limit_mb)
        state = ydoc.get_update()
        if len(state) > 12*1024*1024:
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
        return room.sequence


def flush_room(document_id):
    room = Collaboration.objects.select_related('document').filter(document_id=document_id).first()
    if not room or room.sequence <= room.synced_sequence:
        return
    adapter = active_storage()
    from .services import storage_key
    key = storage_key(room.document, extension='wiki.json' if unpack(room.snapshot) else None)
    if room.document.folder:
        adapter.ensure_dir(key.rpartition('/')[0])
    reference = adapter.write(key, room.snapshot.encode())
    with transaction.atomic():
        current = Collaboration.objects.filter(document_id=document_id).first()
        if current and current.synced_sequence < room.sequence and Document.objects.filter(
                pk=document_id, reference=room.document.reference,
                folder_id=room.document.folder_id).update(reference=reference, path_synced=True):
            current.synced_sequence = room.sequence
            current.save(update_fields=['synced_sequence'])
            return
    adapter.delete(reference)


def current_content(document):
    room = Collaboration.objects.filter(document=document).first()
    return room.snapshot if room and room.snapshot else active_storage().read(document.reference).decode()
