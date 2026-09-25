"""Portable, versioned editor snapshots and safe server-side previews."""
import csv
import html
import io
import json
import re
from urllib.parse import urlparse
from django.core.exceptions import ValidationError

MAGIC = 'yourwiki'


def unpack(content):
    try:
        value = json.loads(content)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) and value.get('format') == MAGIC and value.get('version') == 1 else None


def pack(kind, data):
    return json.dumps({'format': MAGIC, 'version': 1, 'kind': kind, 'data': data}, ensure_ascii=False, separators=(',', ':'))


def validate_native(kind, value):
    if value.get('kind') != kind or not isinstance(value.get('data'), dict):
        raise ValidationError('Invalid native document.')
    if kind == 'document':
        count = [0]
        def visit(node, depth=0):
            count[0] += 1
            if depth > 40 or count[0] > 50000 or not isinstance(node, dict):
                raise ValidationError('Document structure exceeds the supported limits.')
            if node.get('type') not in {'doc','paragraph','text','heading','blockquote','bulletList','orderedList','listItem','codeBlock','hardBreak','horizontalRule','image','table','tableRow','tableCell','tableHeader'}:
                raise ValidationError('Unsupported document element.')
            for child in node.get('content', []):
                visit(child, depth+1)
        visit(value['data'])
    elif kind == 'table':
        data=value['data']
        sheets=data.get('sheets')
        if not isinstance(sheets,dict) or not 1<=len(sheets)<=20:
            raise ValidationError('A workbook supports 1–20 sheets.')
        for sheet in sheets.values():
            if not isinstance(sheet,dict) or type(sheet.get('rowCount')) is not int or not 1<=sheet['rowCount']<=2000 or type(sheet.get('columnCount')) is not int or not 1<=sheet['columnCount']<=200:
                raise ValidationError('Each sheet supports up to 2,000 rows and 200 columns.')
            if not isinstance(sheet.get('cellData',{}),dict):
                raise ValidationError('Invalid cell data.')
            for row,cells in sheet.get('cellData',{}).items():
                if not str(row).isdigit() or int(row)>=sheet['rowCount'] or not isinstance(cells,dict):
                    raise ValidationError('Invalid row data.')
                for col,cell in cells.items():
                    if not str(col).isdigit() or int(col)>=sheet['columnCount'] or not isinstance(cell,dict):
                        raise ValidationError('Invalid cell data.')
                    formula=cell.get('f','')
                    if formula and (not isinstance(formula,str) or re.search(r'\b(?:IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTRANGE|IMAGE|WEBSERVICE|HYPERLINK)\s*\(',formula,re.I)):
                        raise ValidationError('External-data formulas are disabled.')


def safe_style(attrs):
    pairs = []
    for key, css in [('color','color'),('backgroundColor','background-color'),('fontSize','font-size'),('fontFamily','font-family'),('textAlign','text-align')]:
        value = str(attrs.get(key, ''))
        valid = (key in ('color','backgroundColor') and re.fullmatch(r'#[0-9a-fA-F]{3,8}', value)
            or key == 'fontSize' and re.fullmatch(r'(?:[8-9]|[1-6][0-9]|7[0-2])(?:px|pt)', value)
            or key == 'fontFamily' and value in ('Arial','Georgia','Verdana','monospace','sans-serif','serif')
            or key == 'textAlign' and value in ('left','center','right','justify'))
        if valid:
            pairs.append(f'{css}:{value}')
    return ' style="'+html.escape(';'.join(pairs), quote=True)+'"' if pairs else ''


def rich_html(node):
    tags = {'doc':'div','paragraph':'p','blockquote':'blockquote','bulletList':'ul','orderedList':'ol','listItem':'li','codeBlock':'pre','hardBreak':'br','horizontalRule':'hr','table':'table','tableRow':'tr','tableCell':'td','tableHeader':'th'}
    kind, attrs = node.get('type'), node.get('attrs') or {}
    if kind == 'text':
        value = html.escape(node.get('text', ''))
        for mark in node.get('marks', []):
            name, ma = mark.get('type'), mark.get('attrs') or {}
            tag = {'bold':'strong','italic':'em','strike':'s','underline':'u','code':'code'}.get(name)
            if tag:
                value = f'<{tag}>{value}</{tag}>'
            elif name == 'textStyle':
                value = '<span'+safe_style(ma)+'>'+value+'</span>'
            elif name == 'highlight':
                value = '<mark'+safe_style({'backgroundColor': ma.get('color', '#ffff88')})+'>'+value+'</mark>'
            elif name == 'link' and urlparse(ma.get('href', '')).scheme in ('http','https','mailto'):
                value = '<a href="'+html.escape(ma['href'], quote=True)+'" rel="noopener noreferrer">'+value+'</a>'
        return value
    if kind == 'image':
        src = str(attrs.get('src', ''))
        if not re.fullmatch(r'/attachments/[0-9a-f-]{36}/', src):
            return ''
        width = attrs.get('width')
        width = f' width="{int(width)}"' if str(width).isdigit() and 16 <= int(width) <= 2000 else ''
        return f'<img src="{src}" alt="{html.escape(str(attrs.get("alt") or ""), quote=True)}"{width}>'
    tag = 'h'+str(max(1, min(6, int(attrs.get('level', 2))))) if kind == 'heading' else tags.get(kind, 'div')
    extra = safe_style(attrs)
    if kind in ('tableCell','tableHeader'):
        for key in ('colspan','rowspan'):
            v = attrs.get(key, 1)
            if type(v) is int and 1 <= v <= 100:
                extra += f' {key}="{v}"'
    return f'<{tag}{extra}>'+''.join(rich_html(n) for n in node.get('content', []))+f'</{tag}>'


def plain_text(node):
    if node.get('type') == 'text':
        return node.get('text', '')
    content = ''.join(plain_text(n) for n in node.get('content', []))
    return content + ('\n' if node.get('type') in ('paragraph','heading','listItem','tableRow','hardBreak') else '')


def markdown_export(node):
    kind=node.get('type')
    if kind=='text':
        text=node.get('text','')
        for mark in node.get('marks',[]):
            marker={'bold':'**','italic':'*','strike':'~~','code':'`'}.get(mark.get('type'))
            if marker:text=marker+text+marker
            elif mark.get('type')=='link':text='['+text+']('+str(mark.get('attrs',{}).get('href',''))+')'
        return text
    content=''.join(markdown_export(n) for n in node.get('content',[]))
    if kind=='heading':return '#'*int(node.get('attrs',{}).get('level',2))+' '+content+'\n\n'
    if kind=='paragraph':return content+'\n\n'
    if kind=='listItem':return '- '+content.strip()+'\n'
    if kind=='blockquote':return '\n'.join('> '+line for line in content.strip().splitlines())+'\n\n'
    if kind=='codeBlock':return '```\n'+plain_text(node).strip()+'\n```\n\n'
    if kind=='horizontalRule':return '\n---\n'
    if kind=='hardBreak':return '  \n'
    if kind=='table':
        rows=[[plain_text(cell).strip().replace('|','\\|').replace('\n',' ') for cell in row.get('content',[])] for row in node.get('content',[])]
        if not rows:return ''
        return '| '+' | '.join(rows[0])+' |\n| '+' | '.join(['---']*len(rows[0]))+' |\n'+''.join('| '+' | '.join(row)+' |\n' for row in rows[1:])+'\n'
    if kind=='image':return '!['+str(node.get('attrs',{}).get('alt',''))+']('+str(node.get('attrs',{}).get('src',''))+')'
    return content


def csv_export(workbook):
    sheets = workbook.get('sheets', {})
    sheet = sheets.get(next(iter(workbook.get('sheetOrder', [])), ''), next(iter(sheets.values()), {}))
    cells = sheet.get('cellData', {})
    rows = min(2000, max((int(r)+1 for r in cells if str(r).isdigit()), default=0))
    cols = min(200, max((int(c)+1 for row in cells.values() for c in row if str(c).isdigit()), default=0))
    stream = io.StringIO()
    writer = csv.writer(stream)
    for r in range(rows):
        writer.writerow([cells.get(str(r), {}).get(str(c), {}).get('v', '') for c in range(cols)])
    return stream.getvalue()
