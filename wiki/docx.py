"""DOCX import and export helpers."""
from io import BytesIO
from .native import pack


def _text(paragraph):
    content = []
    for run in paragraph.runs:
        marks = []
        if run.bold:
            marks.append({'type': 'bold'})
        if run.italic:
            marks.append({'type': 'italic'})
        if run.underline:
            marks.append({'type': 'underline'})
        if run.text:
            content.append({'type': 'text', 'text': run.text, 'marks': marks})
    if not content and paragraph.text:
        content.append({'type': 'text', 'text': paragraph.text, 'marks': []})
    return content


def _paragraph(paragraph):
    style = paragraph.style.name if paragraph.style else ''
    if style.startswith('Heading '):
        try:
            return {'type': 'heading', 'attrs': {'level': max(1, min(6, int(style.rsplit(' ', 1)[1])))}, 'content': _text(paragraph)}
        except ValueError:
            pass
    return {'type': 'paragraph', 'content': _text(paragraph)}


def _table(table):
    rows = []
    for row in table.rows:
        rows.append({'type': 'tableRow', 'content': [
            {'type': 'tableCell', 'content': [_paragraph(p) for p in cell.paragraphs]}
            for cell in row.cells
        ]})
    return {'type': 'table', 'content': rows}


def to_native(data):
    from docx import Document
    source = Document(data)
    content = []
    from docx.table import Table
    for block in source.iter_inner_content():
        content.append(_table(block) if isinstance(block, Table) else _paragraph(block))
    return pack('document', {'type': 'doc', 'content': content or [{'type': 'paragraph'}]})


def to_docx(native_text):
    from docx import Document
    from .native import unpack
    native = unpack(native_text) or {'data': {'content': []}}
    output = Document()
    def blocks(parent, nodes, list_style=None):
        for node in nodes:
            kind = node.get('type')
            children = node.get('content', [])
            if kind == 'table':
                rows = children
                columns = max((sum(int(c.get('attrs', {}).get('colspan', 1)) for c in r.get('content', [])) for r in rows), default=0)
                if not rows or not columns: continue
                table = parent.add_table(rows=len(rows), cols=columns)
                table.style = 'Table Grid'
                for r, row in enumerate(rows):
                    c = 0
                    for cell in row.get('content', []):
                        target = table.cell(r, c)
                        attrs = cell.get('attrs', {})
                        width, height = max(1, int(attrs.get('colspan', 1))), max(1, int(attrs.get('rowspan', 1)))
                        if width > 1 or height > 1:
                            target = target.merge(table.cell(min(len(rows)-1, r+height-1), min(columns-1, c+width-1)))
                        blocks(target, cell.get('content', []))
                        if len(target.paragraphs) > 1:
                            empty = target.paragraphs[0]._element
                            empty.getparent().remove(empty)
                        c += width
            elif kind in ('bulletList', 'orderedList'):
                blocks(parent, children, 'List Bullet' if kind == 'bulletList' else 'List Number')
            elif kind in ('listItem', 'blockquote'):
                blocks(parent, children, list_style or ('Quote' if kind == 'blockquote' else None))
            elif kind in ('paragraph', 'heading', 'codeBlock'):
                paragraph = parent.add_paragraph(style=list_style)
                if kind == 'heading':
                    paragraph.style = f"Heading {max(1, min(6, int(node.get('attrs', {}).get('level', 1))))}"
                from docx.enum.text import WD_ALIGN_PARAGRAPH
                alignment = node.get('attrs', {}).get('textAlign')
                if alignment in ('left', 'center', 'right', 'justify'):
                    paragraph.alignment = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'center': WD_ALIGN_PARAGRAPH.CENTER, 'right': WD_ALIGN_PARAGRAPH.RIGHT, 'justify': WD_ALIGN_PARAGRAPH.JUSTIFY}[alignment]
                for child in children:
                    run = paragraph.add_run(child.get('text', ''))
                    if child.get('type') == 'hardBreak': run.add_break()
                    marks = {mark.get('type') for mark in child.get('marks', [])}
                    run.bold, run.italic, run.underline = 'bold' in marks, 'italic' in marks, 'underline' in marks
                    run.font.strike = 'strike' in marks
                    if kind == 'codeBlock' or 'code' in marks: run.font.name = 'Courier New'
            elif children:
                blocks(parent, children, list_style)
    blocks(output, native['data'].get('content', []))
    stream = BytesIO(); output.save(stream)
    return stream.getvalue()
