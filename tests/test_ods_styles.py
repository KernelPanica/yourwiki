import io
import zipfile
import pytest
from django.core.exceptions import ValidationError
from wiki.file_formats import write_ods,read_ods
from wiki.native import pack,unpack


def workbook(style):
    return pack('table',{'sheetOrder':['s'],'sheets':{'s':{'name':'Sheet','rowCount':2,'columnCount':2,
        'cellData':{'0':{'0':{'v':12.5,'s':style}}}}}})


def foreign(raw):
    stream=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source,zipfile.ZipFile(stream,'w') as target:
        for name in source.namelist():
            if name!='meta.xml':target.writestr(name,source.read(name))
    return unpack(read_ods(stream.getvalue()))['data']['sheets']['sheet1']['cellData']['0']['0']['s']


def test_standard_ods_extended_styles_do_not_depend_on_metadata():
    style={'ul':{'s':1},'st':{'s':1},'vt':2,'tb':3,'ht':3,
           'bd':{'t':{'s':8,'cl':{'rgb':'#ff0000'}},'b':{'s':7,'cl':{'rgb':'#000000'}}}}
    assert foreign(write_ods(workbook(style),'Sheet'))==style


@pytest.mark.parametrize('pattern',['0','0.00','#,##0.00','0.00%','$#,##0.00','yyyy-mm-dd','hh:mm:ss','yyyy-mm-dd hh:mm:ss'])
def test_standard_ods_number_formats_roundtrip(pattern):
    assert foreign(write_ods(workbook({'n':{'pattern':pattern}}),'Sheet'))['n']['pattern']==pattern


def test_strict_ods_rejects_unrepresentable_formatting():
    with pytest.raises(ValidationError,match='format'):
        write_ods(workbook({'tr':{'a':45}}),'Sheet',strict_styles=True)
    with pytest.raises(ValidationError,match='format'):
        write_ods(workbook({'n':{'pattern':'[Red][<10]0.00;0'}}),'Sheet',strict_styles=True)


@pytest.mark.django_db
def test_local_writer_rejects_unsupported_format_before_mutating_file(workspace):
    from wiki.services import save_document
    from wiki.storage import active_storage
    doc=save_document(workspace['admin'],'Styles','table','Notes',workbook({'bl':1}),workspace['team'])
    before=active_storage().read(doc.reference)
    with pytest.raises(ValidationError,match='format'):
        save_document(workspace['admin'],'Styles','table','Notes',workbook({'tr':{'a':45}}),workspace['team'],doc,doc.revision)
    assert active_storage().read(doc.reference)==before
    with pytest.raises(ValidationError,match='format'):
        write_ods(workbook({'tb':2}),'Sheet',strict_styles=True)


def test_standard_datetime_uses_month_and_minute_elements():
    raw=write_ods(workbook({'n':{'pattern':'yyyy-mm-dd hh:mm:ss'}}),'Sheet')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        xml=archive.read('content.xml')
    assert b'<number:month' in xml and b'<number:minutes' in xml
