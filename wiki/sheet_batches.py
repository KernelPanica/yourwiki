"""Precise, atomic native Sheets updates without importing over the original."""
import re
from .file_formats import read_ods
from .native import unpack


def _color(value):
    if not isinstance(value,dict) or set(value)-{'rgb'}:
        return None
    value = value.get('rgb', '') if isinstance(value, dict) else ''
    if re.fullmatch(r'#[0-9a-fA-F]{3}', value):
        value = '#' + ''.join(character*2 for character in value[1:])
    if re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        return dict(zip(('red','green','blue'), (int(value[i:i+2],16)/255 for i in (1,3,5))))


def _style_fields(style):
    fields, unsupported = {}, {}
    for key, value in style.items():
        field, converted = None, None
        if ((key in ('ht','vt','tb') and value == 0) or (key == 'n' and value is None)):
            continue
        if key in ('bl','it') and value in (0,1,False,True):
            field, converted = 'textFormat.' + {'bl':'bold','it':'italic'}[key], bool(value)
        elif key in ('ul','st') and isinstance(value,dict) and set(value) <= {'s'} and value.get('s') in (0,1):
            field, converted = 'textFormat.' + {'ul':'underline','st':'strikethrough'}[key], bool(value['s'])
        elif key == 'ff' and isinstance(value,str):
            field, converted = 'textFormat.fontFamily', value
        elif key == 'fs' and isinstance(value,(int,float)) and not isinstance(value,bool) and value > 0:
            field, converted = 'textFormat.fontSize', value
        elif key in ('ht','vt','tb'):
            choices = {'ht':{1:'LEFT',2:'CENTER',3:'RIGHT'},'vt':{1:'TOP',2:'MIDDLE',3:'BOTTOM'},
                       'tb':{1:'OVERFLOW_CELL',2:'CLIP',3:'WRAP'}}
            if isinstance(value,int) and value in choices[key]:
                field, converted = {'ht':'horizontalAlignment','vt':'verticalAlignment','tb':'wrapStrategy'}[key], choices[key][value]
        elif key in ('cl','bg') and _color(value) is not None:
            field, converted = {'cl':'textFormat.foregroundColor','bg':'backgroundColor'}[key], _color(value)
        elif key == 'n' and isinstance(value,dict) and set(value) <= {'pattern','type'} and isinstance(value.get('pattern'),str):
            # Univer stores the pattern; preserve an explicit provider type when available.
            pattern = value['pattern']
            kind = value.get('type') or ('PERCENT' if '%' in pattern else 'SCIENTIFIC' if re.search(r'[eE][+-]0',pattern)
                    else 'DATE_TIME' if re.search(r'[dy]',pattern,re.I) and re.search(r'[hs]',pattern,re.I)
                    else 'DATE' if re.search(r'[dy]',pattern,re.I) else 'TIME' if re.search(r'[hs]',pattern,re.I)
                    else 'TEXT' if pattern == '@' else 'CURRENCY' if re.search(r'[$€£¥₽]',pattern) else 'NUMBER')
            if kind in ('NUMBER','PERCENT','SCIENTIFIC','DATE_TIME','DATE','TIME','TEXT','CURRENCY'):
                field, converted = 'numberFormat', {'type':kind,'pattern':pattern}
        elif key == 'bd' and isinstance(value,dict):
            remaining = {}
            styles = {1:'SOLID',3:'DOTTED',4:'DASHED',7:'DOUBLE',8:'SOLID_MEDIUM',13:'SOLID_THICK'}
            for side,border in value.items():
                if side in ('t','b','l','r') and (border is None or border == {'s':0}):
                    continue
                if (side not in ('t','b','l','r') or not isinstance(border,dict)
                        or set(border)-{'s','cl'} or border.get('s') not in styles
                        or ('cl' in border and _color(border['cl']) is None)):
                    remaining[side] = border
                    continue
                converted_border = {'style':styles[border['s']]}
                if 'cl' in border: converted_border['color'] = _color(border['cl'])
                fields['userEnteredFormat.borders.' + {'t':'top','b':'bottom','l':'left','r':'right'}[side]] = converted_border
            if remaining: unsupported[key] = remaining
            continue
        if field is None:
            unsupported[key] = value
        elif converted not in (False, '', None):
            fields['userEnteredFormat.' + field] = converted
    if unsupported:
        fields['_unsupported'] = unsupported
    return fields


def _cells(workbook, sheet):
    result = {}
    for row, cells in sheet.get('cellData', {}).items():
        for column, cell in cells.items():
            fields = {}
            value = cell.get('v')
            if cell.get('f'):
                fields['userEnteredValue'] = {'formulaValue':cell['f']}
            elif value is not None:
                key = ('boolValue' if isinstance(value, bool) else 'numberValue'
                       if isinstance(value, (int, float)) else 'stringValue')
                fields['userEnteredValue'] = {key:value}
            style = cell.get('s') or {}
            if isinstance(style, str):
                style = workbook.get('styles', {}).get(style, {})
            fields.update(_style_fields(style))
            if fields:
                result[(int(row),int(column))] = fields
    return result


def requests_for(previous, data, sheet_ids, *, structure=None):
    """Return one atomic batch, rejecting changes that cannot be preserved."""
    old, new = (unpack(read_ods(raw))['data'] for raw in (previous, data))
    def ordered(book):
        return [book['sheets'][sid] for sid in book.get('sheetOrder', book['sheets'])]
    before, after = ordered(old), ordered(new)
    requests, pairs = _sheet_requests(before, after, new.get('_axes', {}), structure or {}, sheet_ids)
    for a,b,sheet_id in pairs:
        left, right = _cells(old,a), _cells(new,b)
        target = new.get('_axes', {}).get(b['name'])
        baseline = target if a.get('_new') else (structure or {}).get(a['name'])
        structural = False
        request_start = len(requests)
        if target and not baseline:
            canonical = {'rows':[f'r{i}' for i in range(a['rowCount'])], 'cols':[f'c{i}' for i in range(a['columnCount'])]}
            if {key:target.get(key) for key in ('rows','cols')} != canonical:
                from .storage import StorageError
                raise StorageError('The saved spreadsheet structure is unavailable. Download your edits and reload the original before changing rows or columns.')
        if baseline and target:
            row_map, col_map = {}, {}
            for axis, dimension, field, limit, mapping in [
                ('rows','ROWS','rowCount',2000,row_map), ('cols','COLUMNS','columnCount',200,col_map)]:
                source_ids, target_ids = baseline.get(axis), target.get(axis)
                _validate_axis(source_ids, limit)
                _validate_axis(target_ids, limit)
                if len(target_ids) != b[field]:
                    from .storage import StorageError
                    raise StorageError('Invalid spreadsheet axis dimensions.')
                operations = _axis_requests(source_ids, target_ids, sheet_id, dimension)
                requests.extend(operations)
                structural = structural or bool(operations)
                indices = {key:i for i,key in enumerate(target_ids)}
                for i,key in enumerate(source_ids):
                    if key in indices:
                        mapping[i] = indices[key]
            # Coordinates beyond the represented editor axes remain a provider tail.
            left = {(row_map.get(r, r + len(target['rows'])-len(baseline['rows'])),
                     col_map.get(c, c + len(target['cols'])-len(baseline['cols']))):cell
                    for (r,c),cell in left.items()
                    if (r in row_map or r >= len(baseline['rows']))
                    and (c in col_map or c >= len(baseline['cols']))}
            # Remote-only tails must not be cleared by the smaller editor snapshot.
            left = {pos:cell for pos,cell in left.items()
                    if pos[0] < len(target['rows']) and pos[1] < len(target['cols'])}
        elif any(a.get(field) != b.get(field) for field in ('rowCount','columnCount')):
            from .storage import StorageError
            raise StorageError('Changing row or column counts requires a tracked editor session. Download your edits and reload the original before changing its structure.')
        def represented_merges(sheet, axes):
            return [merge for merge in sheet.get('mergeData', []) if not axes or
                    (merge['endRow'] < len(axes['rows']) and merge['endColumn'] < len(axes['cols']))]
        old_merges, new_merges = represented_merges(a, baseline), represented_merges(b, target)
        rebuild_merges = structural or old_merges != new_merges
        if rebuild_merges:
            for merge in reversed(old_merges):
                requests.insert(request_start, {'unmergeCells':{'range':_merge_range(sheet_id, merge)}})
        current = None
        last = None
        for pos in sorted(left.keys() | right.keys()):
            old_cell, new_cell = left.get(pos, {}), right.get(pos, {})
            if old_cell.get('_unsupported') != new_cell.get('_unsupported'):
                from .storage import StorageError
                raise StorageError('Unsupported spreadsheet formatting change. Download your edits before reloading the original.')
            changed = sorted(key for key in old_cell.keys() | new_cell.keys()
                             if key != '_unsupported' and old_cell.get(key) != new_cell.get(key))
            if structural and new_cell.get('userEnteredValue', {}).get('formulaValue') and 'userEnteredValue' not in changed:
                changed = sorted([*changed, 'userEnteredValue'])
            if not changed:
                continue
            cell = {}
            for key in changed:
                if key not in new_cell:
                    continue  # A masked but absent field resets precisely that property.
                target = cell
                parts = key.split('.')
                for part in parts[:-1]:
                    target = target.setdefault(part, {})
                target[parts[-1]] = new_cell[key]
            mask = ','.join(changed)
            if current is None or last != (pos[0],pos[1]-1) or current['fields'] != mask:
                current = {'start':{'sheetId':sheet_id, 'rowIndex':pos[0], 'columnIndex':pos[1]},
                           'rows':[{'values':[]}], 'fields':mask}
                requests.append({'updateCells':current})
            current['rows'][0]['values'].append(cell)
            last = pos
        if rebuild_merges:
            for merge in new_merges:
                requests.append({'mergeCells':{'range':_merge_range(sheet_id, merge), 'mergeType':'MERGE_ALL'}})
    return requests


def _sheet_requests(before, after, axes, structure, sheet_ids):
    """Match editor identity to the original numeric ID before mutating titles."""
    from .storage import StorageError
    old_names, new_names = [s['name'] for s in before], [s['name'] for s in after]
    if (not after or len(set(old_names)) != len(old_names) or len(set(new_names)) != len(new_names)
            or any(not isinstance(name,str) or not name or len(name)>100 for name in new_names)
            or any(name not in sheet_ids for name in old_names)):
        raise StorageError('Invalid spreadsheet sheet identity. Reload the original before saving.')
    tracked = all(structure.get(name,{}).get('id') for name in old_names)
    target_tracked = all(axes.get(name,{}).get('id') for name in new_names)
    if tracked and not target_tracked:
        raise StorageError('The spreadsheet sheet identity is missing. Reload the original before saving.')
    if tracked and target_tracked:
        old_keys = [structure[name]['id'] for name in old_names]
        new_keys = [axes[name]['id'] for name in new_names]
        if (any(not isinstance(key,str) or not key or len(key)>160 for key in old_keys+new_keys)
                or len(set(old_keys)) != len(old_keys) or len(set(new_keys)) != len(new_keys)):
            raise StorageError('Invalid spreadsheet sheet identity. Reload the original before saving.')
    else:
        # Legacy snapshots can safely edit/reorder sheets only while titles match.
        if set(old_names) != set(new_names):
            raise StorageError('The saved spreadsheet sheet identity is unavailable. Reload the original before changing sheets.')
        old_keys, new_keys = old_names, new_names
    originals = dict(zip(old_keys,before))
    used = set(sheet_ids.values())
    if any(not isinstance(value,int) or isinstance(value,bool) or value < 0 for value in used):
        raise StorageError('Invalid provider sheet identity.')
    requests, pairs, renamed = [], [], []
    for key,b in zip(new_keys,after):
        a = originals.get(key)
        if a is None:
            numeric_id = 0
            while numeric_id in used: numeric_id += 1
            used.add(numeric_id)
            # Use a temporary title because an old sheet can currently hold this title.
            a = {'name':b['name'],'rowCount':b['rowCount'],'columnCount':b['columnCount'],
                 'cellData':{},'_new':True}
            requests.append({'addSheet':{'properties':{'sheetId':numeric_id,
                'title':_temporary_title(sheet_ids, axes, numeric_id),
                'gridProperties':{'rowCount':b['rowCount'],'columnCount':b['columnCount']}}}})
            renamed.append((numeric_id,b['name']))
        else:
            numeric_id = sheet_ids[a['name']]
            if a['name'] != b['name']:
                requests.append({'updateSheetProperties':{'properties':{'sheetId':numeric_id,
                    'title':_temporary_title(sheet_ids,axes,numeric_id)},'fields':'title'}})
                renamed.append((numeric_id,b['name']))
        pairs.append((a,b,numeric_id))
    for key,a in originals.items():
        if key not in new_keys:
            requests.append({'deleteSheet':{'sheetId':sheet_ids[a['name']]}})
    for numeric_id,title in renamed:
        requests.append({'updateSheetProperties':{'properties':{'sheetId':numeric_id,'title':title},'fields':'title'}})
    if old_keys != new_keys:
        for index,(_,_,numeric_id) in enumerate(pairs):
            requests.append({'updateSheetProperties':{'properties':{'sheetId':numeric_id,'index':index},'fields':'index'}})
    return requests,pairs


def _temporary_title(sheet_ids, axes, numeric_id):
    title = f'YourWiki pending {numeric_id}'
    while title in sheet_ids or title in axes:
        title += '_'
    return title


def _validate_axis(ids, limit):
    from .storage import StorageError
    if (not isinstance(ids, list) or not 1 <= len(ids) <= limit
            or any(not isinstance(key, str) or not key or len(key)>160 for key in ids)
            or len(set(ids)) != len(ids)):
        raise StorageError('Invalid spreadsheet axis identity. Reload the original before saving.')


def _axis_requests(before, after, sheet_id, dimension):
    """Transform stable identities; moving real dimensions preserves notes/validation."""
    current = list(before)
    wanted = set(after)
    requests = []
    def span(start, end):
        return {'sheetId':sheet_id, 'dimension':dimension, 'startIndex':start, 'endIndex':end}
    if not wanted.intersection(current):
        return [{'insertDimension':{'range':span(0,len(after)), 'inheritFromBefore':False}},
                {'deleteDimension':{'range':span(len(after),len(after)+len(before))}}]
    # Delete runs from the end so earlier indexes remain valid.
    end = len(current)
    while end:
        if current[end-1] in wanted:
            end -= 1
            continue
        start = end-1
        while start and current[start-1] not in wanted:
            start -= 1
        requests.append({'deleteDimension':{'range':span(start,end)}})
        del current[start:end]
        end = start
    i = 0
    while i < len(after):
        if i < len(current) and current[i] == after[i]:
            i += 1
            continue
        if after[i] in current:
            source = current.index(after[i], i)
            count = 1
            while source+count < len(current) and i+count < len(after) and current[source+count] == after[i+count]:
                count += 1
            requests.append({'moveDimension':{'source':span(source,source+count), 'destinationIndex':i}})
            block = current[source:source+count]
            del current[source:source+count]
            current[i:i] = block
            i += count
        else:
            end = i+1
            while end < len(after) and after[end] not in current:
                end += 1
            requests.append({'insertDimension':{'range':span(i,end), 'inheritFromBefore':i>0}})
            current[i:i] = after[i:end]
            i = end
    return requests


def _merge_range(sheet_id, merge):
    return {'sheetId':sheet_id, 'startRowIndex':merge['startRow'], 'endRowIndex':merge['endRow']+1,
            'startColumnIndex':merge['startColumn'], 'endColumnIndex':merge['endColumn']+1}
