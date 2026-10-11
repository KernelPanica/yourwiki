"""Import locally downloaded editor state without trusting its metadata."""
from .storage import auxiliary_limit_bytes
import base64
import json
from django.core.exceptions import ValidationError
from pycrdt import Doc
from .collaboration import derive
from .services import validate_content
from .models import SiteConfiguration


def decode_snapshot(raw):
    try:
        value=json.loads(raw)
        if value.get('format')!='yourwiki-recovery' or value.get('version')!=1:
            raise ValueError()
        kind=value['kind']
        if kind not in ('document','table','canvas','drawio'):raise ValueError()
        state=base64.b64decode(value['state'],validate=True)
        if not state or (auxiliary_limit_bytes(12*1024*1024, 3) is not None and len(state)>auxiliary_limit_bytes(12*1024*1024, 3)):raise ValueError()
        ydoc=Doc();ydoc.apply_update(state);content=derive(ydoc,kind)
        validate_content(kind,content,SiteConfiguration.current().document_limit_mb)
        file_format=value.get('file_format') or ('docx' if kind=='document' else 'ods' if kind=='table' else None)
        if file_format not in {'document':('md','docx'),'table':('ods',),'canvas':(None,),'drawio':(None,)}[kind]:raise ValueError()
        return kind,content,file_format
    except Exception:
        raise ValidationError('Invalid or oversized recovery snapshot.') from None
