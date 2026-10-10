from wiki.native import pack
from wiki.previews import preview


def test_sheet_preview_keeps_order_dimensions_and_blank_cells():
    content = pack('table', {'sheetOrder': ['second', 'first'], 'sheets': {
        'first': {'name': 'January', 'rowCount': 3, 'columnCount': 28,
                  'cellData': {'2': {'27': {'v': 42}}}},
        'second': {'name': 'February', 'rowCount': 2, 'columnCount': 2,
                   'cellData': {'0': {'0': {'v': 'Name'}, '1': {'f': '=1+1', 'v': 2}}}},
    }})
    sheets = preview('table', content)['worksheets']
    assert [sheet['name'] for sheet in sheets] == ['February', 'January']
    assert sheets[0]['rows'] == [['Name', 2], ['', '']]
    assert sheets[1]['columns'][-2:] == ['AA', 'AB']
    assert sheets[1]['rows'][2][27] == 42
    assert (sheets[1]['row_count'], sheets[1]['column_count']) == (3, 28)


def test_csv_preview_has_coordinates_and_ragged_rows_are_padded():
    sheet = preview('table', 'Name,Value\nOnly name')['worksheets'][0]
    assert sheet['columns'] == ['A', 'B']
    assert sheet['rows'] == [['Name', 'Value'], ['Only name', '']]


def test_sheet_preview_resolves_stable_axes_in_display_order():
    content = pack('table', {'sheetOrder': ['s'], 'sheets': {'s': {
        'name': 'Ordered', 'rowCount': 2, 'columnCount': 2,
        'cellData': {'old-row': {'old-col': {'v': 'Moved'}}},
    }}, '_layout': {'s': {'rows': {'old-row': 1, 'new-row': 0},
                         'cols': {'old-col': 1, 'new-col': 0}}}})
    sheet = preview('table', content)['worksheets'][0]
    assert sheet['rows'] == [['', ''], ['', 'Moved']]


def test_large_sheet_preview_is_bounded_without_losing_dimension_counts():
    content = pack('table', {'sheets': {'s': {
        'name': 'Large', 'rowCount': 1_000_000, 'columnCount': 10_000,
        'cellData': {'1999': {'199': {'v': 'Visible boundary'}}},
    }}})
    sheet = preview('table', content)['worksheets'][0]
    assert (sheet['row_count'], sheet['column_count']) == (1_000_000, 10_000)
    assert len(sheet['rows']) == 2000
    assert len(sheet['columns']) == 200
    assert sheet['rows'][-1][-1] == 'Visible boundary'
    assert sheet['truncated']


def test_sheet_preview_shows_uncached_formulas_and_keeps_zero_values():
    content = pack('table', {'sheets': {'s': {
        'cellData': {'0': {'0': {'f': '=SUM(A2:A3)', 'v': None},
                           '1': {'v': 0}, '2': {'v': None}}},
    }}})
    assert preview('table', content)['worksheets'][0]['rows'] == [['=SUM(A2:A3)', 0, '']]
