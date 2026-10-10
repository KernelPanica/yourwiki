import json
from pycrdt import Doc, Map
from wiki.collaboration import diagram_data, diagram_xml, diagram_parse, element_data, flatten, unflatten, derive
from wiki.graphics import canvas_nodes


XML = '''<mxfile host="offline" xmlns:ext="urn:extension" ext:version="2">before<ext:meta>one<ext:item/>two</ext:meta>between<diagram id="p" name="Page" custom="kept">lead<mxGraphModel grid="1" ext:setting="yes">model<ext:before/>before-root<root custom="root">head<mxCell id="0"/>tail<mxCell id="1" parent="0"/><object id="n" label="Card" ext:flag="x"><mxCell vertex="1" parent="1"><mxGeometry x="1" y="2" width="30" height="40" as="geometry"/></mxCell></object><ext:root-extra/>end</root>after-root<ext:after/>model-end</mxGraphModel>page-tail<ext:page-extra/>page-end</diagram>file-tail<!--kept--></mxfile>'''


def test_diagram_envelope_namespaces_and_mixed_content_roundtrip():
    data = diagram_data(XML)
    assert element_data(diagram_parse(diagram_xml(data))) == element_data(diagram_parse(XML))
    data['pages']['p']['cells']['n']['attrs']['label'] = 'Edited'
    result = diagram_data(diagram_xml(data))
    assert result['pages']['p']['cells']['n']['attrs']['label'] == 'Edited'
    assert result['xml'] == data['xml']
    assert result['pages']['p']['root'] == data['pages']['p']['root']


def test_diagram_deleted_cell_is_not_restored_by_envelope():
    data = diagram_data(XML)
    del data['pages']['p']['cells']['n']
    assert 'n' not in diagram_data(diagram_xml(data))['pages']['p']['cells']


def test_concurrent_canvas_movements_add_and_replay_is_idempotent():
    initial = Doc()
    initial['objects'] = Map(dict(flatten({'nodes':{'n':{'id':'n','x':10,'y':20,'custom':'kept'}}, 'edges':{}})))
    clients = [Doc(), Doc()]
    updates = []
    for index, client in enumerate(clients):
        client.apply_update(initial.get_update())
        mapping = client.get('objects', type=Map)
        for path, value in flatten({'translations':{'n':{f'op-{index}':{'x':5 if index == 0 else -2,'y':3}}}}):
            mapping[path] = value
        updates.append(client.get_update())
    for client in clients:
        for update in updates + updates:
            client.apply_update(update)
        nodes = canvas_nodes(unflatten(client.get('objects', type=Map).to_py()))
        assert nodes == [{'id':'n','x':13,'y':26,'custom':'kept'}]
        snapshot=json.loads(derive(client,'canvas'))
        assert snapshot['nodes']==nodes
        assert 'translations' not in snapshot
