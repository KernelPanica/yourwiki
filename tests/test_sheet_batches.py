import copy
import pytest
from wiki.file_formats import write_ods
from wiki.native import pack


def ods(cells):
    return write_ods(pack('table', {'sheetOrder':['s'], 'sheets':{'s':{
        'name':'Budget', 'rowCount':200, 'columnCount':26, 'cellData':cells}}}), 'Budget')


def test_sparse_values_formulas_and_clears_preserve_untouched_cells():
    from wiki.sheet_batches import requests_for
    before = {'0':{'0':{'v':'keep'}, '1':{'v':1}, '2':{'v':'remove'}},
              '5':{'8':{'v':True}}}
    after = copy.deepcopy(before)
    after['0']['1'] = {'f':'=A2+1', 'v':9}
    del after['0']['2']
    after['5']['8'] = {'v':False}
    requests = requests_for(ods(before), ods(after), {'Budget':42})
    assert requests == [
        {'updateCells':{'start':{'sheetId':42,'rowIndex':0,'columnIndex':1},
          'rows':[{'values':[{'userEnteredValue':{'formulaValue':'=A2+1'}}, {}]}],
          'fields':'userEnteredValue'}},
        {'updateCells':{'start':{'sheetId':42,'rowIndex':5,'columnIndex':8},
          'rows':[{'values':[{'userEnteredValue':{'boolValue':False}}]}],
          'fields':'userEnteredValue'}}]
    assert requests_for(ods(after), ods(after), {'Budget':42}) == []


def test_style_mask_does_not_clear_remote_number_format_or_notes():
    from wiki.sheet_batches import requests_for
    before = {'0':{'0':{'v':12,'s':{'bl':1,'it':1}}}}
    after = {'0':{'0':{'v':12,'s':{'it':1}}}}
    request = requests_for(ods(before), ods(after), {'Budget':7})[0]['updateCells']
    assert request['fields'] == 'userEnteredFormat.textFormat.bold'
    assert request['rows'] == [{'values':[{}]}]


def test_untracked_topology_changes_fail_before_any_mutation():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    with pytest.raises(StorageError, match='identity'):
        requests_for(ods({}), write_ods('a,b', 'Different'), {'Budget':7})


def test_styled_blank_cells_survive_provider_export_without_metadata():
    import io
    import zipfile
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    original = ods({'0':{'0':{'s':{'bg':{'rgb':'#ff0000'}}}}})
    stream = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(stream,'w') as target:
        for name in source.namelist():
            if name != 'meta.xml':
                target.writestr(name, source.read(name))
    book = unpack(read_ods(stream.getvalue()))['data']
    assert book['sheets']['sheet1']['cellData']['0']['0']['s']['bg']['rgb'] == '#ff0000'


def test_grid_resize_is_not_reported_as_successful_empty_batch():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    before = ods({'0':{'0':{'v':'keep'}}})
    book = unpack(read_ods(before))['data']
    book['sheets']['s']['rowCount'] += 1
    after = write_ods(pack('table',book), 'Budget')
    with pytest.raises(StorageError, match='row or column'):
        requests_for(before, after, {'Budget':42})


def structured(cells, rows, cols):
    return write_ods(pack('table', {'sheetOrder':['s'], 'sheets':{'s':{
        'name':'Budget', 'rowCount':len(rows), 'columnCount':len(cols), 'cellData':cells}},
        '_axes':{'Budget':{'rows':rows,'cols':cols}}}), 'Budget')


def test_native_insert_and_delete_remap_existing_cells_without_rewriting_them():
    from wiki.sheet_batches import requests_for
    before = structured({'0':{'0':{'v':'A'}},'1':{'0':{'v':'B'}}}, ['a','b'], ['x','y'])
    after = structured({'0':{'0':{'v':'A'}},'1':{'0':{'v':'new'}},'2':{'0':{'v':'B'}}},
                       ['a','new','b'], ['x'])
    requests = requests_for(before, after, {'Budget':42}, structure={'Budget':{'rows':['a','b'],'cols':['x','y']}})
    assert requests[:2] == [
        {'insertDimension':{'range':{'sheetId':42,'dimension':'ROWS','startIndex':1,'endIndex':2},'inheritFromBefore':True}},
        {'deleteDimension':{'range':{'sheetId':42,'dimension':'COLUMNS','startIndex':1,'endIndex':2}}}]
    assert requests[2:] == [{'updateCells':{'start':{'sheetId':42,'rowIndex':1,'columnIndex':0},
        'rows':[{'values':[{'userEnteredValue':{'stringValue':'new'}}]}], 'fields':'userEnteredValue'}}]


def test_reordering_rows_moves_provider_metadata_instead_of_replacing_values():
    from wiki.sheet_batches import requests_for
    before = structured({'0':{'0':{'v':'A'}},'1':{'0':{'v':'B'}}}, ['a','b'], ['x'])
    after = structured({'0':{'0':{'v':'B'}},'1':{'0':{'v':'A'}}}, ['b','a'], ['x'])
    assert requests_for(before, after, {'Budget':42}, structure={'Budget':{'rows':['a','b'],'cols':['x']}}) == [
        {'moveDimension':{'source':{'sheetId':42,'dimension':'ROWS','startIndex':1,'endIndex':2},'destinationIndex':0}}]


def test_untrusted_or_missing_axis_baseline_cannot_guess_structure():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    before = structured({}, ['a','b'], ['x'])
    after = structured({}, ['a','new','b'], ['x'])
    with pytest.raises(StorageError):
        requests_for(before, after, {'Budget':42})
    invalid = structured({}, ['a','a'], ['x'])
    with pytest.raises(StorageError):
        requests_for(before, invalid, {'Budget':42}, structure={'Budget':{'rows':['a','b'],'cols':['x']}})


def test_missing_baseline_also_rejects_same_size_identity_changes():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    before = structured({}, ['a','b'], ['x'])
    after = structured({}, ['b','a'], ['x'])
    with pytest.raises(StorageError):
        requests_for(before, after, {'Budget':42})


def test_insert_with_changed_merge_stays_native():
    from wiki.sheet_batches import requests_for
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    before = structured({'0':{'0':{'v':'Merged'}}}, ['a','b'], ['x','y'])
    book = unpack(read_ods(before))['data']
    book['sheets']['s']['mergeData'] = [{'startRow':0,'endRow':1,'startColumn':0,'endColumn':0}]
    before = write_ods(pack('table',book),'Budget')
    book['sheets']['s']['rowCount'] = 3
    book['sheets']['s']['mergeData'][0]['endRow'] = 2
    book['_axes']['Budget']['rows'] = ['a','new','b']
    after = write_ods(pack('table',book),'Budget')
    result = requests_for(before,after,{'Budget':42},structure={'Budget':{'rows':['a','b'],'cols':['x','y']}})
    assert result is not None
    assert result[0] == {'unmergeCells':{'range':{'sheetId':42,'startRowIndex':0,'endRowIndex':2,'startColumnIndex':0,'endColumnIndex':1}}}
    assert result[-1] == {'mergeCells':{'range':{'sheetId':42,'startRowIndex':0,'endRowIndex':3,'startColumnIndex':0,'endColumnIndex':1},'mergeType':'MERGE_ALL'}}


def test_grid_dimensions_survive_export_without_yourwiki_metadata():
    import io
    import zipfile
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    original = structured({'0':{'0':{'v':'A'}}}, [f'r{i}' for i in range(199)], ['a','b','c'])
    stream = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(stream,'w') as target:
        for name in source.namelist():
            if name != 'meta.xml': target.writestr(name,source.read(name))
    sheet = unpack(read_ods(stream.getvalue()))['data']['sheets']['sheet1']
    assert (sheet['rowCount'],sheet['columnCount']) == (199,3)


def test_structural_edit_does_not_unmerge_provider_tail():
    from wiki.sheet_batches import requests_for
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    before = structured({}, [f'r{i}' for i in range(8)], ['x','y'])
    book = unpack(read_ods(before))['data']
    book['sheets']['s']['mergeData'] = [{'startRow':5,'endRow':6,'startColumn':0,'endColumn':1}]
    before = write_ods(pack('table',book),'Budget')
    after = structured({}, ['r0','new','r1'], ['x','y'])
    requests = requests_for(before,after,{'Budget':42},structure={'Budget':{'rows':['r0','r1'],'cols':['x','y']}})
    assert not any('unmergeCells' in request for request in requests)


def topology(sheets):
    book = {'sheetOrder':[], 'sheets':{}, '_axes':{}}
    for sid, name, value in sheets:
        book['sheetOrder'].append(sid)
        book['sheets'][sid] = {'name':name, 'rowCount':2, 'columnCount':2,
                              'cellData':{'0':{'0':{'v':value}}}}
        book['_axes'][name] = {'id':sid, 'rows':['r0','r1'], 'cols':['c0','c1']}
    return write_ods(pack('table',book), 'Workbook')


def test_native_sheet_identity_survives_rename_add_delete_and_reorder():
    from wiki.sheet_batches import requests_for
    before = topology([('a','Alpha','A'),('b','Beta','B'),('c','Gone','C')])
    after = topology([('b','Alpha','B'),('d','New','D'),('a','Beta','A')])
    structure = {name:{'id':sid,'rows':['r0','r1'],'cols':['c0','c1']}
                 for sid,name in [('a','Alpha'),('b','Beta'),('c','Gone')]}
    result = requests_for(before,after,{'Alpha':42,'Beta':71,'Gone':99},structure=structure)
    assert {'deleteSheet':{'sheetId':99}} in result
    added = next(request['addSheet']['properties'] for request in result if 'addSheet' in request)
    assert added['sheetId'] not in (42,71,99)
    assert any(request.get('updateSheetProperties',{}).get('properties') ==
               {'sheetId':71,'title':'Alpha'} for request in result)
    assert any(request.get('updateSheetProperties',{}).get('properties') ==
               {'sheetId':42,'title':'Beta'} for request in result)
    assert [r['updateCells']['start']['sheetId'] for r in result if 'updateCells' in r] == [added['sheetId']]
    assert [r['updateSheetProperties']['properties'] for r in result
            if r.get('updateSheetProperties',{}).get('fields') == 'index'] == [
                {'sheetId':71,'index':0},{'sheetId':added['sheetId'],'index':1},{'sheetId':42,'index':2}]


def test_native_extended_formats_and_precise_removal():
    from wiki.sheet_batches import requests_for
    style = {'ul':{'s':1},'st':{'s':1},'vt':2,'tb':3,
             'bd':{'b':{'s':1,'cl':{'rgb':'#ff0000'}}},'n':{'pattern':'0.00'}}
    requests = requests_for(ods({}),ods({'0':{'0':{'s':style}}}),{'Budget':42})
    cell = requests[0]['updateCells']['rows'][0]['values'][0]['userEnteredFormat']
    assert cell['textFormat'] == {'underline':True,'strikethrough':True}
    assert cell['verticalAlignment'] == 'MIDDLE'
    assert cell['wrapStrategy'] == 'WRAP'
    assert cell['borders']['bottom']['style'] == 'SOLID'
    assert cell['numberFormat'] == {'type':'NUMBER','pattern':'0.00'}
    cleared = requests_for(ods({'0':{'0':{'s':style}}}),ods({}),{'Budget':42})
    assert cleared[0]['updateCells']['rows'] == [{'values':[{}]}]
    assert cleared[0]['updateCells']['fields'] == requests[0]['updateCells']['fields']


def test_unsupported_style_changes_fail_but_unchanged_provider_extras_survive():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    before = ods({'0':{'0':{'v':'a','s':{'tr':{'a':30}}}}})
    after = ods({'0':{'0':{'v':'b','s':{'tr':{'a':30}}}}})
    assert requests_for(before,after,{'Budget':42})[0]['updateCells']['fields'] == 'userEnteredValue'
    with pytest.raises(StorageError, match='format'):
        requests_for(before,ods({'0':{'0':{'s':{'tr':{'a':45}}}}}),{'Budget':42})


@pytest.mark.parametrize('univer,google', [(1,'SOLID'),(3,'DOTTED'),(4,'DASHED'),
                                         (7,'DOUBLE'),(8,'SOLID_MEDIUM'),(13,'SOLID_THICK')])
def test_border_styles_follow_installed_univer_enum(univer, google):
    from wiki.sheet_batches import requests_for
    result = requests_for(ods({}),ods({'0':{'0':{'s':{'bd':{'t':{'s':univer}}}}}}),{'Budget':42})
    assert result[0]['updateCells']['rows'][0]['values'][0]['userEnteredFormat']['borders']['top']['style'] == google


def test_supported_format_default_reset_is_precise():
    from wiki.sheet_batches import requests_for
    before = ods({'0':{'0':{'s':{'ht':2,'vt':2,'tb':2,'n':{'pattern':'0.00'},'bd':{'b':{'s':1}}}}}})
    after = ods({'0':{'0':{'s':{'ht':0,'vt':0,'tb':0,'n':None,'bd':{'b':None}}}}})
    request = requests_for(before,after,{'Budget':42})[0]['updateCells']
    assert request['rows'] == [{'values':[{}]}]
    assert request['fields'] == 'userEnteredFormat.borders.bottom,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy'


@pytest.mark.parametrize('value,expected', [(1,'OVERFLOW_CELL'),(2,'CLIP'),(3,'WRAP')])
def test_wrap_strategy_matches_univer(value,expected):
    from wiki.sheet_batches import requests_for
    result = requests_for(ods({}),ods({'0':{'0':{'s':{'tb':value}}}}),{'Budget':42})
    assert result[0]['updateCells']['rows'][0]['values'][0]['userEnteredFormat']['wrapStrategy'] == expected


def test_tracked_sheets_do_not_fall_back_to_title_if_identity_disappears():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    from wiki.file_formats import read_ods
    from wiki.native import unpack
    before = topology([('a','Alpha','A')])
    target = unpack(read_ods(before))['data']
    del target['_axes']
    with pytest.raises(StorageError,match='identity'):
        requests_for(before,write_ods(pack('table',target),'Book'),{'Alpha':42},structure={'Alpha':{'id':'a','rows':['r0','r1'],'cols':['c0','c1']}})


@pytest.mark.parametrize('border', [2,5,6,9,10,11,12])
def test_unrepresentable_border_changes_are_explicitly_rejected(border):
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    before = ods({'0':{'0':{'v':'A','s':{'bd':{'t':{'s':border}}}}}})
    after = ods({'0':{'0':{'v':'B','s':{'bd':{'t':{'s':border}}}}}})
    assert requests_for(before,after,{'Budget':42})[0]['updateCells']['fields'] == 'userEnteredValue'
    with pytest.raises(StorageError,match='format'):
        requests_for(ods({}),after,{'Budget':42})


def test_nested_unsupported_color_changes_are_not_silently_ignored():
    from wiki.sheet_batches import requests_for
    from wiki.storage import StorageError
    before = ods({'0':{'0':{'s':{'cl':{'rgb':'#ff0000','th':1}}}}})
    after = ods({'0':{'0':{'s':{'cl':{'rgb':'#ff0000','th':2}}}}})
    with pytest.raises(StorageError,match='format'):
        requests_for(before,after,{'Budget':42})
