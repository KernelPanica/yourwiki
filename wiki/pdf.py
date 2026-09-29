"""PDF import and export helpers."""
from html import escape
from io import BytesIO
from .native import pack, unpack

def process_pdf(data, *, extract=False):
    """Parse untrusted PDFs in a bounded worker, outside the web process."""
    import json
    import subprocess
    import sys
    from django.core.exceptions import ValidationError
    from django.utils.translation import gettext as _
    if hasattr(data, 'read'):
        data = data.read(5 * 1024 * 1024 + 1)
    if not isinstance(data, bytes) or len(data) > 5 * 1024 * 1024 or not data.startswith(b'%PDF-'):
        raise ValidationError(_('Use a PDF file no larger than 5 MB.'))
    try:
        result = subprocess.run([sys.executable, '-m', 'wiki.pdf', 'extract' if extract else 'validate'],
                                input=data, capture_output=True, timeout=20, check=True)
        value = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        raise ValidationError(_('This PDF could not be processed within the supported limits.')) from None
    if 'error' in value:
        raise ValidationError(_(value['error']))
    return value


def to_native(data):
    text = process_pdf(data, extract=True)['text']
    content = [{'type': 'paragraph', 'content': [{'type': 'text', 'text': line}]} for line in text.splitlines() if line.strip()]
    return pack('document', {'type': 'doc', 'content': content or [{'type': 'paragraph'}]})


def to_pdf(native_text, title='Document'):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    native = unpack(native_text) or {'data': {'content': []}}
    output = BytesIO(); document = SimpleDocTemplate(output, pagesize=A4, title=title)
    styles = getSampleStyleSheet(); story = []
    for node in native['data'].get('content', []):
        text = ''.join(c.get('text','') for c in node.get('content', []) if c.get('type') == 'text')
        if text:
            style = styles['Heading2'] if node.get('type') == 'heading' else styles['BodyText']
            story.extend([Paragraph(escape(text), style), Spacer(1, 8)])
    document.build(story or [Paragraph(escape(title), styles['Title'])])
    return output.getvalue()


def _worker():
    import json
    import resource
    import sys
    # PDF streams may expand far beyond the upload size; keep limits in the child.
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    from pypdf import PdfReader
    try:
        reader = PdfReader(BytesIO(sys.stdin.buffer.read(5 * 1024 * 1024 + 1)))
        if reader.is_encrypted:
            raise ValueError('Unlock password-protected PDFs before uploading.')
        if not 1 <= len(reader.pages) <= 200:
            raise ValueError('PDFs support between 1 and 200 pages.')
        result = {'pages': len(reader.pages)}
        if sys.argv[-1] == 'extract':
            parts = []
            size = 0
            has_text = False
            for number, page in enumerate(reader.pages, 1):
                text = page.extract_text() or ''
                for reference in page.get('/Annots', []):
                    annotation = reference.get_object()
                    if annotation.get('/Contents'):
                        text += '\n[Annotation] ' + str(annotation['/Contents'])
                has_text = has_text or bool(text.strip())
                size += len(text)
                if size > 200000:
                    raise ValueError('The PDF contains too much text. Split it into smaller files.')
                parts.append(f'[Page {number}]\n{text.strip() or "[No extractable page text; images were not read.]"}')
            fields = reader.get_fields() or {}
            field_text = '\n'.join(f"{name}: {field.get('/V', '')}" for name, field in fields.items() if field.get('/V'))
            if field_text:
                has_text = True
                size += len(field_text)
                parts.append('[Form fields]\n' + field_text)
            if size > 200000:
                raise ValueError('The PDF contains too much text. Split it into smaller files.')
            if not has_text:
                raise ValueError('This PDF has no extractable text. Run OCR on scanned pages first.')
            result['text'] = '\n\n'.join(parts)
        print(json.dumps(result))
    except ValueError as error:
        print(json.dumps({'error': str(error)}))
    except Exception:
        print(json.dumps({'error': 'The PDF is damaged or unsupported.'}))


if __name__ == '__main__':
    _worker()
