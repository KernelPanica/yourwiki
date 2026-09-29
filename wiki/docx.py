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
    for paragraph in source.paragraphs:
        content.append(_paragraph(paragraph))
    for table in source.tables:
        content.append(_table(table))
    return pack('document', {'type': 'doc', 'content': content or [{'type': 'paragraph'}]})


def to_docx(native_text):
    from docx import Document
    from .native import unpack
    native = unpack(native_text) or {'data': {'content': []}}
    output = Document()
    for node in native['data'].get('content', []):
        if node.get('type') not in ('paragraph', 'heading'):
            continue
        paragraph = output.add_paragraph()
        if node['type'] == 'heading':
            paragraph.style = f"Heading {max(1, min(6, int(node.get('attrs', {}).get('level', 1))))}"
        for child in node.get('content', []):
            run = paragraph.add_run(child.get('text', ''))
            marks = {mark.get('type') for mark in child.get('marks', [])}
            run.bold, run.italic, run.underline = 'bold' in marks, 'italic' in marks, 'underline' in marks
    stream = BytesIO(); output.save(stream)
    return stream.getvalue()
