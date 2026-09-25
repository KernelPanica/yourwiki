import json
from unittest.mock import patch
import pytest
from django.urls import reverse
from wiki.models import Document
from wiki.storage import StorageError,active_storage
from wiki.services import save_document,Conflict

@pytest.mark.django_db
class TestDocuments:
    def test_create_read_edit_export(self,client,workspace):
        client.force_login(workspace['admin'])
        response=client.post('/api/docs',data=json.dumps({'title':'Created','content':'# Content','group':'team'}),content_type='application/json')
        assert response.status_code==201,response.content
        id=response.json()['id']
        assert client.get('/api/docs/'+id).json()['content']=='# Content'
        response=client.put('/api/docs/'+id,data=json.dumps({'title':'Updated','content':'# Changed','revision':1}),content_type='application/json')
        assert response.status_code==200,response.content
        assert response.json()['revision']==2
        assert client.get(reverse('export',args=[id])).content==b'# Changed'
        assert len(list(workspace['root'].iterdir()))==2

    def test_conflicting_save_does_not_overwrite(self,client,workspace,document):
        client.force_login(workspace['admin'])
        response=client.put(f'/api/docs/{document.pk}',data=json.dumps({'content':'new','revision':99}),content_type='application/json')
        assert response.status_code==409
        document.refresh_from_db();assert document.revision==1
        assert b'Some knowledge' in active_storage().read(document.reference)

    def test_failed_storage_preserves_editor_content(self,client,workspace,document):
        client.force_login(workspace['admin'])
        with patch('wiki.services.active_storage') as adapter:
            adapter.return_value.write.side_effect=StorageError('Unavailable')
            response=client.post(reverse('edit',args=[document.pk]),{'title':'Changed','collection':'Engineering','content':'UNSAVED TEXT','revision':1})
        assert response.status_code==503,response.content
        assert b'UNSAVED TEXT' in response.content
        document.refresh_from_db();assert document.title=='A useful document'

    def test_pages_render(self,client,workspace,document):
        client.force_login(workspace['admin'])
        for url in ['/', '/?q=useful','/?view=grid','/?kind=table','/documents/new/','/documents/import/','/permissions/','/storage/','/settings/','/invitations/','/members/',reverse('document',args=[document.pk]),reverse('edit',args=[document.pk]),reverse('policy',args=[document.pk])]:
            assert client.get(url).status_code==200,url

    def test_preview_kinds(self,client,workspace):
        client.force_login(workspace['admin'])
        samples={
            'table':'Name,Notes\n"A, B","two\nlines"',
            'canvas':json.dumps({'nodes':[{'id':'n','type':'text','text':'A node','x':0,'y':0,'width':200,'height':100}],'edges':[]}),
            'drawio':'<mxfile><diagram><mxGraphModel><root><mxCell id="n" value="Node" vertex="1"><mxGeometry x="0" y="0" width="100" height="50"/></mxCell></root></mxGraphModel></diagram></mxfile>'}
        for kind,content in samples.items():
            doc=save_document(workspace['admin'],kind,kind,'Tests',content,workspace['team'])
            response=client.get(reverse('document',args=[doc.pk]))
            assert response.status_code==200
            assert b'Preview unavailable' not in response.content
            assert b'<table' in response.content if kind=='table' else b'<svg class="graph"' in response.content

    def test_import_and_limit(self,client,workspace):
        from django.core.files.uploadedfile import SimpleUploadedFile
        client.force_login(workspace['admin'])
        response=client.post('/documents/import/',{'file':SimpleUploadedFile('table.csv',b'Name,Status\nOne,Ready')})
        assert response.status_code==302
        assert Document.objects.get().kind=='table'
        assert client.post('/documents/import/',{'file':SimpleUploadedFile('bad.exe',b'bad')}).status_code==400

    def test_delete_and_star(self,client,workspace,document):
        client.force_login(workspace['admin'])
        assert client.post(reverse('star',args=[document.pk])).status_code==302
        document.refresh_from_db();assert document.starred
        assert client.post(reverse('delete',args=[document.pk])).status_code==302
        assert not Document.objects.exists()

    def test_bad_api_input_and_policy(self,client,workspace,document):
        client.force_login(workspace['admin'])
        assert client.post('/api/docs',data='[]',content_type='application/json').status_code==400
        assert client.put(f'/api/docs/{document.pk}',data='{"policy":{}}',content_type='application/json').status_code==400
        assert client.post('/api/docs',data=json.dumps({'title':'x','kind':'canvas','content':'{}'}),content_type='application/json').status_code==400

    def test_api_delete_and_retry_queue(self,client,workspace,document):
        from wiki.models import PendingDeletion
        from wiki.services import cleanup_storage
        client.force_login(workspace['admin'])
        with patch('wiki.services.active_storage') as adapter:
            adapter.return_value.delete.side_effect=StorageError('offline')
            response=client.delete(f'/api/docs/{document.pk}')
        assert response.status_code==202
        assert not Document.objects.exists()
        assert PendingDeletion.objects.count()==1
        cleanup_storage()
        assert PendingDeletion.objects.count()==0

    def test_mixed_api_updates_are_rejected_without_changes(self,client,workspace,document):
        client.force_login(workspace['admin'])
        response=client.put(f'/api/docs/{document.pk}',data=json.dumps({'content':'changed','revision':1,'policy':{}}),content_type='application/json')
        assert response.status_code==400
        document.refresh_from_db();assert document.revision==1
