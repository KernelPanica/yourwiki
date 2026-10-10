"""Quick number formats must work in ODS and provider batches."""
from io import BytesIO
from zipfile import ZipFile
import pytest
from wiki.file_formats import write_ods, read_ods
from wiki.native import pack, unpack
from wiki.sheet_batches import _style_fields


@pytest.mark.parametrize('pattern', ['0', '0.00', '#,##0.00', '0.00%', '₽#,##0.00', 'yyyy-mm-dd', 'hh:mm:ss', '@'])
def test_quick_number_formats_survive_ods(pattern):
    data = {'sheets': {'sheet': {'name':'Sheet 1', 'rowCount':10, 'columnCount':10,
                                'cellData': {'0': {'0': {'v':12.5, 's': {'n': {'pattern':pattern}}}}}}},
            'sheetOrder':['sheet']}
    raw = write_ods(pack('table', data), 'Formats', strict_styles=True)
    restored = unpack(read_ods(raw))['data']
    cell = next(iter(restored['sheets'].values()))['cellData']['0']['0']
    style = cell['s']
    if isinstance(style, str):
        style = restored['styles'][style]
    assert style['n']['pattern'] == pattern
    if pattern.startswith('₽'):
        assert _style_fields(style)['userEnteredFormat.numberFormat']['type'] == 'CURRENCY'
        with ZipFile(BytesIO(raw)) as archive:
            assert '₽'.encode() in archive.read('content.xml')
