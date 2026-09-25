import base64
import csv
import html
from html.parser import HTMLParser
import io
import json
import math
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
        result.append({**n, 'label': str(n.get('label', '')), 'color': colors.get(str(n.get('color')), '#fff'), 'inner_x': n['x']+12, 'inner_y': n['y']+12, 'inner_width': max(0,n['width']-24), 'inner_height': max(0,n['height']-24)})
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
            ax,ay,bx,by=a['x']+a['width']/2,a['y']+a['height'],b['x']+b['width']/2,b['y']
            links.append({'path':f'M{ax},{ay} C{ax},{ay+60} {bx},{by-60} {bx},{by}', 'label':e.get('label',''), 'x':(ax+bx)/2,'y':(ay+by)/2})
    return {'nodes': result, 'edges': links, 'viewbox': f'{x} {y} {width} {height}'}


def preview(kind, text):
    from .native import unpack, rich_html, csv_export
    native = unpack(text)
    if native and kind == 'document':
        return {'markdown': rich_html(native['data'])}
    if native and kind == 'table':
        return {'rows': list(csv.reader(io.StringIO(csv_export(native['data']))))}
    if kind == 'document':
        cleaner = Cleaner()
        cleaner.feed(markdown.markdown(html.escape(text), extensions=['tables','fenced_code']))
        return {'markdown': ''.join(cleaner.parts)}
    if kind == 'table':
        return {'rows': list(csv.reader(io.StringIO(text)))[:2000]}
    if kind == 'canvas':
        data = json.loads(text)
        nodes = [{**n, 'label':n.get('text') or n.get('file') or n.get('url') or n.get('label') or 'Group'} for n in data['nodes']]
        edges = [{'from':e.get('fromNode'),'to':e.get('toNode'),'label':e.get('label','')} for e in data.get('edges',[])]
        return graph(nodes,edges)
    root = fromstring(text)
    model = root if root.tag == 'mxGraphModel' else root.find('.//mxGraphModel')
    if model is None:
        diagram = root.find('.//diagram')
        if diagram is None or not diagram.text:
            raise ValueError('No diagram page found.')
        inflater = zlib.decompressobj(-15)
        raw = inflater.decompress(base64.b64decode(diagram.text), 5*1024*1024+1)
        if len(raw) > 5*1024*1024 or not inflater.eof:
            raise ValueError('The decompressed diagram is too large.')
        model = fromstring(unquote(raw.decode()))
    nodes,edges=[],[]
    for cell in model.iter('mxCell'):
        if cell.get('vertex') == '1':
            geo = cell.find('mxGeometry')
            if geo is None: continue
            label = PlainText(); label.feed(cell.get('value',''))
            nodes.append({'id':cell.get('id'), 'label':''.join(label.text), **{k:float(geo.get(k, '160' if k=='width' else '70' if k=='height' else '0')) for k in ('x','y','width','height')}})
        elif cell.get('edge') == '1':
            edges.append({'from':cell.get('source'),'to':cell.get('target'),'label':cell.get('value','')})
    return graph(nodes,edges)
