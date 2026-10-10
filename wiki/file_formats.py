"""Portable files with editor metadata embedded in their standard containers."""
import hashlib
import io
import json
import re
import zipfile
from functools import wraps
from xml.etree.ElementTree import Element, SubElement, tostring
from defusedxml.ElementTree import fromstring
from django.core.exceptions import ValidationError
from .native import pack, unpack, markdown_export, validate_native

ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet'
MIMES = {'md': 'text/markdown; charset=utf-8', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'ods': ODS_MIME}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def valid_container(reader):
    @wraps(reader)
    def read(data):
        try:
            return reader(data)
        except ValidationError:
            raise
        except Exception as error:
            raise ValidationError('The document is damaged or uses an unsupported format.') from error
    return read


def checked_archive(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    entries = archive.infolist()
    if len(entries) > 1000 or sum(i.file_size for i in entries) > 50 * 1024 * 1024 or len({i.filename for i in entries}) != len(entries):
        archive.close()
        raise ValidationError('The document archive exceeds supported limits.')
    return archive


def metadata(content, visible):
    return json.dumps({'format': 'yourwiki-embedded', 'version': 1, 'sha256': digest(visible), 'content': content}, ensure_ascii=False)


def embedded(value, visible, kind):
    try:
        meta = json.loads(value)
        if meta.get('format') == 'yourwiki-embedded' and meta.get('version') == 1 and meta.get('sha256') == digest(visible):
            content = meta['content']
            native = unpack(content)
            if native:
                validate_native(kind, native)
            if isinstance(content, str):
                return content
    except (ValueError, KeyError, TypeError, AttributeError):
        pass
    return None


def read_markdown(data):
    text = data.decode('utf-8-sig')
    if text.startswith('---\n'):
        header, separator, body = text[4:].partition('\n---\n')
        if separator:
            try:
                value = json.loads(header).get('yourwiki')
            except (ValueError, AttributeError):
                value = None
            if value is not None:
                return embedded(json.dumps(value), body.encode(), 'document') or body
    return text


def formula(value, to_odf=True):
    # Strings are opaque; transform A1 references and argument separators only outside them.
    parts = re.split(r'("(?:[^"]|"")*")', value)
    for i in range(0, len(parts), 2):
        if to_odf:
            parts[i] = re.sub(r"(?<![\w.])((?:'[^']+'|[A-Za-z_][\w]*)!)?(\$?[A-Z]{1,3}\$?[1-9][0-9]*)(?::(\$?[A-Z]{1,3}\$?[1-9][0-9]*))?(?![\w(])", lambda m: '[' + (m[1][:-1] if m[1] else '') + '.' + m[2] + (':.' + m[3] if m[3] else '') + ']', parts[i]).replace(',', ';')
        else:
            parts[i] = re.sub(r'\[([^\]]+)\]', lambda m: m[1].lstrip('.').replace(':.', ':').replace('.', '!'), parts[i]).replace(';', ',')
    return ('of:' if to_odf else '') + ''.join(parts).removeprefix('of:')


def _ods_number_style(pattern, name):
    """Compile the supported pattern subset into standard ODF number elements."""
    from odf import number as n
    numeric = re.fullmatch(r'([$€£¥₽]?)(#[,]##)?(0+)(?:\.(0+))?(%)?',pattern)
    if numeric:
        currency,grouping,integer,decimal,percent = numeric.groups()
        node = (n.CurrencyStyle if currency else n.PercentageStyle if percent else n.NumberStyle)(name=name)
        if currency:node.addElement(n.CurrencySymbol(text=currency))
        node.addElement(n.Number(minintegerdigits=len(integer),decimalplaces=len(decimal or ''),grouping=bool(grouping)))
        if percent:node.addElement(n.Text(text='%'))
        return node
    if pattern == '@':
        node=n.TextStyle(name=name);node.addElement(n.TextContent());return node
    tokens = re.findall(r'yyyy|yy|mm|dd|hh|ss|[-/: ]',pattern)
    if tokens and ''.join(tokens)==pattern and any(token in ('yyyy','yy','dd','hh','ss') for token in tokens):
        time = 'hh' in tokens or 'ss' in tokens
        node = (n.DateStyle if 'dd' in tokens or 'yyyy' in tokens or 'yy' in tokens else n.TimeStyle)(name=name)
        classes={'yyyy':n.Year,'yy':n.Year,'mm':n.Minutes if time and not ('dd' in tokens) else n.Month,
                 'dd':n.Day,'hh':n.Hours,'ss':n.Seconds}
        in_time = False
        for token in tokens:
            if token in ('hh','ss'):in_time = True
            factory = n.Minutes if token=='mm' and in_time else classes.get(token)
            node.addElement(factory(style='short' if token=='yy' else 'long') if factory else n.Text(text=token))
        return node
    raise ValidationError('Unsupported spreadsheet number formatting. Export your edits before changing the format.')


def write_ods(content, title, *, strict_styles=False):
    from odf.opendocument import OpenDocumentSpreadsheet
    from odf.table import Table, TableRow, TableCell, CoveredTableCell, TableColumn
    from odf.style import Style, TextProperties, TableCellProperties, ParagraphProperties
    from odf.text import P
    native = unpack(content)
    if not native:
        from .collaboration import seed, derive
        from .models import Document
        content = derive(seed(Document(kind='table', title=title), content), 'table')
        native = unpack(content)
    workbook = native['data']
    output = OpenDocumentSpreadsheet()
    styles = {}
    def cell_style(value):
        style = workbook.get('styles', {}).get(value, {}) if isinstance(value, str) else value or {}
        key = json.dumps(style, sort_keys=True)
        if not style: return None
        if key not in styles:
            name = 'cell' + str(len(styles))
            node = Style(name=name, family='table-cell')
            text = {}
            if strict_styles:
                from .sheet_batches import _style_fields
                if _style_fields(style).get('_unsupported'):
                    raise ValidationError('Unsupported spreadsheet formatting for ODS export.')
                if style.get('tb') == 2:
                    raise ValidationError('Clipped spreadsheet text formatting cannot be represented faithfully in ODS.')
            if style.get('bl'): text['fontweight'] = 'bold'
            if style.get('it'): text['fontstyle'] = 'italic'
            if style.get('ff'): text['fontfamily'] = style['ff']
            if style.get('fs'): text['fontsize'] = str(style['fs']) + 'pt'
            if (style.get('ul') or {}).get('s') == 1:
                text.update(textunderlinestyle='solid',textunderlinetype='single')
            if (style.get('st') or {}).get('s') == 1:
                text.update(textlinethroughstyle='solid',textlinethroughtype='single')
            color = style.get('cl', {})
            if isinstance(color, dict) and color.get('rgb'): text['color'] = color['rgb']
            if text: node.addElement(TextProperties(**text))
            background = style.get('bg', {})
            cell_props = {}
            if isinstance(background, dict) and background.get('rgb'): cell_props['backgroundcolor'] = background['rgb']
            if style.get('vt') in (1,2,3):cell_props['verticalalign'] = {1:'top',2:'middle',3:'bottom'}[style['vt']]
            if style.get('tb') in (1,2,3):cell_props['wrapoption'] = 'wrap' if style['tb']==3 else 'no-wrap'
            border_styles={1:('0.75pt','solid'),3:('0.75pt','dotted'),4:('0.75pt','dashed'),
                           7:('2.25pt','double'),8:('1.5pt','solid'),13:('2.25pt','solid')}
            for side,border in (style.get('bd') or {}).items():
                if side not in ('t','b','l','r') or not isinstance(border,dict):continue
                if border.get('s') not in border_styles:continue
                width,kind=border_styles[border['s']]
                cell_props['border'+{'t':'top','b':'bottom','l':'left','r':'right'}[side]]=f"{width} {kind} {(border.get('cl') or {}).get('rgb','#000000')}"
            if cell_props:node.addElement(TableCellProperties(**cell_props))
            if style.get('n',{}):
                try:
                    number_style = _ods_number_style(style['n']['pattern'],name+'number')
                    output.automaticstyles.addElement(number_style)
                    node.setAttribute('datastylename',name+'number')
                except (ValidationError,KeyError,TypeError):
                    if strict_styles:raise ValidationError('Unsupported spreadsheet number formatting for ODS export.') from None
            if style.get('ht') in (1, 2, 3): node.addElement(ParagraphProperties(textalign={1:'left', 2:'center', 3:'right'}[style['ht']]))
            output.automaticstyles.addElement(node)
            styles[key] = name
        return styles[key]
    for sid in workbook.get('sheetOrder', list(workbook['sheets'])):
        sheet = workbook['sheets'].get(sid)
        if not sheet:
            continue
        table = Table(name=sheet.get('name', sid))
        cells = sheet.get('cellData', {})
        rows = max((int(r)+1 for r in cells), default=1)
        columns = max((int(c)+1 for row in cells.values() for c in row), default=1)
        merges = sheet.get('mergeData', [])
        covered = set()
        spans = {}
        for merge in merges:
            r0, r1, c0, c1 = (int(merge[k]) for k in ('startRow','endRow','startColumn','endColumn'))
            if not (0 <= r0 <= r1 < 2000 and 0 <= c0 <= c1 < 200): raise ValidationError('Invalid merged cell range.')
            rows, columns = max(rows, r1+1), max(columns, c1+1)
            spans[(r0,c0)] = (r1-r0+1,c1-c0+1)
            covered.update((r,c) for r in range(r0,r1+1) for c in range(c0,c1+1) if (r,c)!=(r0,c0))
        table.addElement(TableColumn(numbercolumnsrepeated=max(columns, sheet.get('columnCount', columns))))
        for r in range(rows):
            row = TableRow()
            for c in range(columns):
                if (r,c) in covered:
                    row.addElement(CoveredTableCell()); continue
                cell = cells.get(str(r), {}).get(str(c), {})
                value = cell.get('v')
                attributes = {}
                style_name = cell_style(cell.get('s'))
                if style_name: attributes['stylename'] = style_name
                if (r,c) in spans:
                    attributes['numberrowsspanned'], attributes['numbercolumnsspanned'] = spans[(r,c)]
                if cell.get('f'):
                    attributes['formula'] = formula(cell['f'])
                if isinstance(value, bool):
                    attributes.update(valuetype='boolean', booleanvalue=str(value).lower())
                elif isinstance(value, (int, float)):
                    attributes.update(valuetype='float', value=value)
                elif value is not None:
                    attributes.update(valuetype='string')
                node = TableCell(**attributes)
                if value is not None:
                    node.addElement(P(text=str(value)))
                row.addElement(node)
            table.addElement(row)
        if sheet.get('rowCount', rows) > rows:
            empty = TableRow(numberrowsrepeated=sheet['rowCount']-rows)
            empty.addElement(TableCell())
            table.addElement(empty)
        output.spreadsheet.addElement(table)
    stream = io.BytesIO(); output.save(stream)
    result = io.BytesIO()
    with zipfile.ZipFile(stream) as source, zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as target:
        meta = fromstring(source.read('meta.xml'))
        container = meta.find('{urn:oasis:names:tc:opendocument:xmlns:office:1.0}meta')
        prop = SubElement(container, '{urn:oasis:names:tc:opendocument:xmlns:meta:1.0}user-defined',
                          {'{urn:oasis:names:tc:opendocument:xmlns:meta:1.0}name': 'yourwiki'})
        prop.text = metadata(content, source.read('content.xml'))
        for entry in source.infolist():
            target.writestr(entry, tostring(meta, encoding='utf-8', xml_declaration=True) if entry.filename == 'meta.xml' else source.read(entry.filename))
    return result.getvalue()



@valid_container
def read_ods(data):
    ns = {'o': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0', 't': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0', 'm': 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0'}
    attr = lambda node, namespace, name, default=None: node.get('{'+ns[namespace]+'}'+name, default)
    ns.update({'s': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0', 'f': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
               'n':'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0'})
    styles = {}
    number_styles,style_number_names = {},{}
    with checked_archive(data) as archive:
        if archive.read('mimetype').decode() != ODS_MIME:
            raise ValidationError('Choose an ODS spreadsheet.')
        visible = archive.read('content.xml')
        for xml in [visible] + ([archive.read('styles.xml')] if 'styles.xml' in archive.namelist() else []):
            tree = fromstring(xml)
            for number_node in tree.findall('.//n:*',ns):
                if not number_node.tag.endswith('-style'):continue
                pattern = ''
                for part in number_node:
                    tag = part.tag.split('}')[-1]
                    long = attr(part,'n','style') == 'long'
                    if tag == 'number':
                        pattern += ('#,##' if attr(part,'n','grouping')=='true' else '') + '0'*int(attr(part,'n','min-integer-digits','1'))
                        decimals = int(attr(part,'n','decimal-places','0'))
                        if decimals:pattern += '.' + '0'*decimals
                    elif tag in ('text','currency-symbol'):pattern += ''.join(part.itertext())
                    elif tag == 'text-content':pattern += '@'
                    elif tag in ('year','month','day','hours','minutes','seconds'):
                        pattern += {'year':'yyyy' if long else 'yy','month':'mm','day':'dd','hours':'hh','minutes':'mm','seconds':'ss'}[tag]
                    else:
                        pattern = '';break
                if pattern:number_styles[attr(number_node,'s','name')] = {'pattern':pattern}
            for node in tree.findall('.//s:style', ns):
                style = {}
                style_number_names[attr(node,'s','name')] = attr(node,'s','data-style-name')
                for props in node:
                    for attribute, key, expected in [('font-weight', 'bl', 'bold'), ('font-style', 'it', 'italic')]:
                        if attr(props, 'f', attribute) == expected:
                            style[key] = 1
                    for attribute, key in [('color', 'cl'), ('background-color', 'bg')]:
                        color = attr(props, 'f', attribute)
                        if color and color != 'transparent':
                            style[key] = {'rgb': color}
                    size = attr(props, 'f', 'font-size', '')
                    if size.endswith('pt'):
                        style['fs'] = float(size[:-2])
                    family = attr(props, 'f', 'font-family')
                    if family:
                        style['ff'] = family
                    align = attr(props, 'f', 'text-align')
                    if align in ('left', 'center', 'right'):
                        style['ht'] = {'left': 1, 'center': 2, 'right': 3}[align]
                    for attribute,key in [('text-underline-style','ul'),('text-line-through-style','st')]:
                        if attr(props,'s',attribute) == 'solid':style[key] = {'s':1}
                    vertical = attr(props,'s','vertical-align')
                    if vertical in ('top','middle','bottom'):style['vt'] = {'top':1,'middle':2,'bottom':3}[vertical]
                    wrapping = attr(props,'f','wrap-option')
                    if wrapping in ('wrap','no-wrap'):style['tb'] = 3 if wrapping=='wrap' else 1
                    for side,short in [('top','t'),('bottom','b'),('left','l'),('right','r')]:
                        border = attr(props,'f','border-'+side) or attr(props,'f','border')
                        match = re.fullmatch(r'([\d.]+)(pt|cm|mm|in) (solid|double|dashed|dotted) (#[0-9a-fA-F]{3,6})',border or '')
                        if not match:continue
                        width = float(match[1])*{'pt':1,'cm':72/2.54,'mm':72/25.4,'in':72}[match[2]]
                        kind = {'dotted':3,'dashed':4,'double':7}.get(match[3],1 if width<1.2 else 8 if width<2 else 13)
                        style.setdefault('bd',{})[short] = {'s':kind,'cl':{'rgb':match[4]}}
                styles[attr(node, 's', 'name')] = (attr(node, 's', 'parent-style-name'), style)
        if 'meta.xml' in archive.namelist():
            for prop in fromstring(archive.read('meta.xml')).findall('.//m:user-defined', ns):
                if attr(prop, 'm', 'name') == 'yourwiki':
                    content = embedded(prop.text or '', visible, 'table')
                    if content:
                        return content
    workbook = {'id': 'workbook', 'name': 'Workbook', 'sheetOrder': [], 'sheets': {}, 'styles': {}}
    def cell_style(name, seen=None):
        seen = set() if seen is None else seen
        if name not in styles or name in seen:
            return {}
        seen.add(name)
        parent, own = styles[name]
        number_name = style_number_names.get(name)
        return {**cell_style(parent, seen), **own,
                **({'n':number_styles[number_name]} if number_name in number_styles else {})}
    for number, table in enumerate(fromstring(visible).findall('.//t:table', ns)):
        if number >= 20:
            raise ValidationError('A workbook supports 1–20 sheets.')
        cells = {}; row_index = 0; merges = []
        columns = max(1, min(200, sum(int(attr(column, 't', 'number-columns-repeated', '1')) for column in table.findall('.//t:table-column', ns))))
        for row in table.findall('.//t:table-row', ns):
            values = {}; col = 0
            for node in row:
                count = int(attr(node, 't', 'number-columns-repeated', '1'))
                if not 1 <= count <= 1048576:
                    raise ValidationError('Invalid repeated cells.')
                value_type = attr(node, 'o', 'value-type')
                value = None
                if value_type in ('float', 'currency', 'percentage'):
                    value = float(attr(node, 'o', 'value', '0'))
                elif value_type == 'boolean':
                    value = attr(node, 'o', 'boolean-value') == 'true'
                elif value_type:
                    value = attr(node, 'o', 'date-value') or attr(node, 'o', 'time-value') or ''.join(node.itertext())
                f = attr(node, 't', 'formula')
                style = cell_style(attr(node, 't', 'style-name'))
                row_span = int(attr(node, 't', 'number-rows-spanned', '1'))
                column_span = int(attr(node, 't', 'number-columns-spanned', '1'))
                if row_span != 1 or column_span != 1:
                    if not (1 <= row_span <= 2000 - row_index and 1 <= column_span <= 200 - col) or count != 1:
                        raise ValidationError('Invalid merged cell range.')
                    merges.append({'startRow': row_index, 'endRow': row_index + row_span - 1, 'startColumn': col, 'endColumn': col + column_span - 1})
                    columns = max(columns, col + column_span)
                if value is not None or f or style:
                    if col + count > 200:
                        raise ValidationError('Each sheet supports up to 2,000 rows and 200 columns.')
                    for c in range(col, col + count):
                        values[str(c)] = {'v': value, **({'f': formula(f, False)} if f else {}), **({'s': style} if style else {})}
                    columns = max(columns, col + count)
                col += count
            count = int(attr(row, 't', 'number-rows-repeated', '1'))
            if not 1 <= count <= 1048576:
                raise ValidationError('Invalid repeated rows.')
            if values:
                if row_index + count > 2000:
                    raise ValidationError('Each sheet supports up to 2,000 rows and 200 columns.')
                for r in range(row_index, row_index + count):
                    cells[str(r)] = values.copy()
            row_index += count
        sid = f'sheet{number+1}'
        workbook['sheetOrder'].append(sid)
        workbook['sheets'][sid] = {'id': sid, 'name': attr(table, 't', 'name', sid), 'rowCount': max(1, min(row_index, 2000), max((int(r)+1 for r in cells), default=1), max((m['endRow']+1 for m in merges), default=1)), 'columnCount': max(1, columns), 'cellData': cells, 'mergeData': merges}
    content = pack('table', workbook)
    validate_native('table', unpack(content))
    return content


@valid_container
def read_docx(data):
    with checked_archive(data) as archive:
        if 'customXml/yourwiki.xml' in archive.namelist():
            content = embedded(fromstring(archive.read('customXml/yourwiki.xml')).text or '', archive.read('word/document.xml'), 'document')
            if content:
                return content
    from .docx import to_native
    return to_native(io.BytesIO(data))


def write_docx(content):
    from .docx import to_docx
    original = to_docx(content)
    with zipfile.ZipFile(io.BytesIO(original)) as source:
        visible = source.read('word/document.xml')
        node = Element('yourwiki'); node.text = metadata(content, visible)
        rels = fromstring(source.read('word/_rels/document.xml.rels'))
        SubElement(rels, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship', {
            'Id': 'rIdYourwiki', 'Type': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml', 'Target': '../customXml/yourwiki.xml'})
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, tostring(rels, encoding='utf-8', xml_declaration=True) if entry.filename == 'word/_rels/document.xml.rels' else source.read(entry.filename))
            target.writestr('customXml/yourwiki.xml', tostring(node, encoding='utf-8', xml_declaration=True))
    return output.getvalue()


def encode(document, content, *, strict_styles=False):
    if isinstance(content, bytes):
        return content
    if document.file_format == 'ods':
        return write_ods(content, document.title, strict_styles=strict_styles)
    if document.file_format == 'docx':
        if not unpack(content):
            from .collaboration import seed, derive
            content = derive(seed(document, content), 'document')
        return write_docx(content)
    if document.file_format == 'md' and unpack(content):
        body = markdown_export(unpack(content)['data']).encode()
        return ('---\n'+json.dumps({'yourwiki': json.loads(metadata(content, body))}, ensure_ascii=False)+'\n---\n').encode() + body
    return content.encode()


def decode(document, data):
    if document.file_format == 'ods': return read_ods(data)
    if document.file_format == 'docx': return read_docx(data)
    return read_markdown(data) if document.file_format == 'md' else data.decode('utf-8')
