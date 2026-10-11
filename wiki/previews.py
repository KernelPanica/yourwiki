from .storage import file_limit_bytes, auxiliary_limit_bytes
import base64
import csv
import html
from html.parser import HTMLParser
import io
import json
import math
import re
from urllib.parse import unquote, urlparse
import zlib
import markdown
from defusedxml.ElementTree import fromstring

class Cleaner(HTMLParser):
    tags = {'p','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','code','pre','blockquote','table','thead','tbody','tr','th','td','hr','br','a'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in self.tags:
            extra = ''
            if tag == 'a':
                href = dict(attrs).get('href', '')
                if urlparse(href).scheme in ('http','https','mailto'):
                    extra = f' href="{html.escape(href, quote=True)}" rel="noreferrer noopener"'
            self.parts.append(f'<{tag}{extra}>')
    def handle_endtag(self, tag):
        if tag in self.tags:
            self.parts.append(f'</{tag}>')
    def handle_data(self, data):
        self.parts.append(html.escape(data))

class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(); self.text = []
    def handle_data(self, data):
        self.text.append(data)


def graph(nodes, edges):
    if len(nodes) > 1000 or len(edges) > 5000:
        raise ValueError('This diagram is too large to preview.')
    result = []
    colors = {'1':'#fee2e2','2':'#ffedd5','3':'#fef9c3','4':'#dcf1e6','5':'#e4edff','6':'#f0e5fb'}
    for n in nodes:
        for k in ('x','y','width','height'):
            value = n.get(k)
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1000000 or (k in ('width','height') and value < 0):
                raise ValueError('Invalid node geometry.')
        result.append({**n, 'label': str(n.get('label', '')), 'color': colors.get(str(n.get('color')), n.get('color') if re.fullmatch(r'#[0-9a-fA-F]{6}', str(n.get('color', ''))) else '#fff'), 'inner_x': n['x']+12, 'inner_y': n['y']+12, 'inner_width': max(0,n['width']-24), 'inner_height': max(0,n['height']-24)})
    if not result:
        return {'nodes': [], 'edges': [], 'viewbox': '0 0 600 400'}
    x = min(n['x'] for n in result)-35; y = min(n['y'] for n in result)-35
    width = max(n['x']+n['width'] for n in result)-x+35
    height = max(n['y']+n['height'] for n in result)-y+35
    mapping = {str(n['id']): n for n in result}
    links = []
    for e in edges:
        a,b = mapping.get(str(e.get('from'))),mapping.get(str(e.get('to')))
        if a and b:
            def anchor(node, side):
                return {'top':(node['x']+node['width']/2,node['y'],0,-1),'bottom':(node['x']+node['width']/2,node['y']+node['height'],0,1),'left':(node['x'],node['y']+node['height']/2,-1,0),'right':(node['x']+node['width'],node['y']+node['height']/2,1,0)}.get(side, (node['x']+node['width']/2,node['y']+node['height'],0,1))
            ax,ay,dx,dy=anchor(a,e.get('fromSide','bottom')); bx,by,ex,ey=anchor(b,e.get('toSide','top'))
            links.append({'path':f'M{ax},{ay} C{ax+dx*60},{ay+dy*60} {bx+ex*60},{by+ey*60} {bx},{by}', 'from_arrow':e.get('fromEnd')=='arrow','to_arrow':e.get('toEnd')!='none','label':e.get('label',''), 'x':(ax+bx)/2,'y':(ay+by)/2})
    return {'nodes': result, 'edges': links, 'viewbox': f'{x} {y} {width} {height}'}


def column_label(index):
    label = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        label = chr(65 + remainder) + label
    return label


def sheet_previews(workbook):
    sheets = workbook.get('sheets', {})
    order = list(dict.fromkeys([*workbook.get('sheetOrder', []), *sheets]))
    result = []
    for sid in order:
        if sid not in sheets:
            continue
        sheet = sheets[sid]
        cells = sheet.get('cellData', {})
        axes = workbook.get('_layout', {}).get(sid)
        if axes:
            row_ids = sorted(axes['rows'], key=lambda key: (axes['rows'][key], key))
            col_ids = sorted(axes['cols'], key=lambda key: (axes['cols'][key], key))
            row_count, column_count = len(row_ids), len(col_ids)
        else:
            row_count = max(sheet.get('rowCount', 0), max((int(r)+1 for r in cells if str(r).isdigit()), default=0), 1)
            column_count = max(sheet.get('columnCount', 0), max((int(c)+1 for row in cells.values() for c in row if str(c).isdigit()), default=0), 1)
            row_ids = [str(r) for r in range(min(row_count, 2000))]
            col_ids = [str(c) for c in range(min(column_count, 200))]
        rows = []
        for rid in row_ids[:2000]:
            row = cells.get(rid, {})
            values = []
            for cid in col_ids[:200]:
                cell = row.get(cid, {})
                value = cell.get('v')
                values.append(cell.get('f', '') if value is None else value)
            rows.append(values)
        result.append({'name': sheet.get('name', sid), 'rows': rows,
                       'columns': [column_label(i+1) for i in range(min(column_count, 200))],
                       'row_count': row_count, 'column_count': column_count,
                       'truncated': row_count > 2000 or column_count > 200})
    return {'worksheets': result}


def preview(kind, text):
    from .native import unpack, rich_html
    native = unpack(text)
    if native and kind == 'document':
        return {'markdown': rich_html(native['data'])}
    if native and kind == 'table':
        return sheet_previews(native['data'])
    if kind == 'document':
        cleaner = Cleaner()
        cleaner.feed(markdown.markdown(html.escape(text), extensions=['tables','fenced_code']))
        return {'markdown': ''.join(cleaner.parts)}
    if kind == 'table':
        rows = list(csv.reader(io.StringIO(text)))
        return sheet_previews({'sheetOrder': ['sheet1'], 'sheets': {'sheet1': {
            'name': 'Sheet 1', 'cellData': {str(r): {str(c): {'v': value} for c, value in enumerate(row)} for r, row in enumerate(rows)},
        }}})
    if kind == 'canvas':
        data = json.loads(text)
        nodes = [{**n, 'label':n.get('text') or n.get('file') or n.get('url') or n.get('label') or 'Group'} for n in data['nodes']]
        nodes.sort(key=lambda node: node.get('type') != 'group')
        edges = [{**e,'from':e.get('fromNode'),'to':e.get('toNode'),'label':e.get('label','')} for e in data.get('edges',[])]
        return graph(nodes,edges)
    root = fromstring(text)
    model = root if root.tag == 'mxGraphModel' else root.find('.//mxGraphModel')
    if model is None:
        diagram = root.find('.//diagram')
        if diagram is None or not diagram.text:
            raise ValueError('No diagram page found.')
        inflater = zlib.decompressobj(-15)
        raw = inflater.decompress(base64.b64decode(diagram.text), (file_limit_bytes() + 1) if file_limit_bytes() is not None else 0)
        if (file_limit_bytes() is not None and len(raw) > file_limit_bytes()) or not inflater.eof:
            raise ValueError('The decompressed diagram is too large.')
        model = fromstring(unquote(raw.decode()))
    nodes,edges=[],[]
    # Draw.io stores grouped geometry relative to its parent, and custom
    # properties wrap mxCell in an object carrying the ID and label.
    parents = {child: parent for parent in model.iter() for child in parent}
    cells = {}
    for cell in model.iter('mxCell'):
        wrapper = parents.get(cell)
        wrapped = wrapper is not None and wrapper.tag != 'root'
        cid = cell.get('id') or (wrapper.get('id') if wrapped else None)
        label = wrapper.get('label', cell.get('value', '')) if wrapped else cell.get('value', '')
        if cid:
            cells[cid] = (cell, label)
    geometry = {}
    def position(cid, visiting=None):
        if cid in geometry: return geometry[cid]
        visiting = set() if visiting is None else visiting
        if cid in visiting: raise ValueError('Invalid diagram parent cycle.')
        visiting.add(cid)
        cell = cells[cid][0]
        geo = cell.find('mxGeometry')
        values = {k:float(geo.get(k, '160' if k=='width' else '70' if k=='height' else '0')) for k in ('x','y','width','height')}
        parent = cell.get('parent')
        if parent in cells and cells[parent][0].get('vertex') == '1' and cells[parent][0].find('mxGeometry') is not None:
            base = position(parent, visiting)
            if geo.get('relative') == '1':
                values['x'] *= base['width']; values['y'] *= base['height']
            values['x'] += base['x']; values['y'] += base['y']
        offset = geo.find("mxPoint[@as='offset']")
        if offset is not None:
            values['x'] += float(offset.get('x', '0')); values['y'] += float(offset.get('y', '0'))
        visiting.remove(cid)
        geometry[cid] = values
        return values
    for cid,(cell,value) in cells.items():
        label = PlainText(); label.feed(value)
        if cell.get('vertex') == '1':
            if cell.find('mxGeometry') is None: continue
            style = dict(part.split('=', 1) for part in cell.get('style', '').split(';') if '=' in part)
            nodes.append({'id':cid, 'label':''.join(label.text), 'color':style.get('fillColor'), **position(cid)})
        elif cell.get('edge') == '1':
            edges.append({'from':cell.get('source'),'to':cell.get('target'),'label':''.join(label.text)})
    # Draw parents first, otherwise a group rectangle hides its children.
    def depth(cid):
        result, seen = 0, set()
        while cid in cells and cid not in seen:
            seen.add(cid); cid = cells[cid][0].get('parent'); result += 1
        return result
    nodes.sort(key=lambda node: depth(node['id']))
    return graph(nodes,edges)


def image_type(content):
    """Only verified raster images may be served inline."""
    from PIL import Image
    try:
        with Image.open(io.BytesIO(content)) as image:
            mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'GIF': 'image/gif',
                    'WEBP': 'image/webp', 'BMP': 'image/bmp'}.get(image.format)
            if not mime:
                return None
            image.verify()
            return mime
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
