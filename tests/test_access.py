import json
import pytest
from django.test import Client
from django.urls import reverse
from wiki.models import Document,User

@pytest.mark.django_db
class TestAccess:
    def test_all_anonymous_protected_routes_return_500(self,client,workspace,document):
        for url in ['/', '/permissions/','/members/','/storage/','/settings/','/invitations/', '/api/docs',f'/api/docs/{document.pk}',reverse('document',args=[document.pk]),reverse('export',args=[document.pk])]:
            response=client.get(url)
            assert response.status_code==500,url
            assert 'Location' not in response
            assert b'<form' not in response.content.lower()
            if url.startswith('/api/'):
                assert response.json()=={'error':'Server error'}
            else:
                assert b'href="/login/">Sign in</a>' in response.content
            assert b'Some knowledge' not in response.content
        for method in ('post','put','delete'):
            response=getattr(client,method)(f'/api/docs/{document.pk}',data='{}',content_type='application/json')
            assert response.status_code==500

    @pytest.mark.parametrize('login_url', ['/login', '/login/'])
    def test_login_and_persistent_session(self,workspace,login_url):
        client=Client(enforce_csrf_checks=True)
        response=client.get(login_url)
        assert response.status_code==200
        assert b'<form' in response.content
        csrf={'HTTP_X_CSRFTOKEN':client.cookies['csrftoken'].value}
        assert client.post(login_url,{'username':'admin','password':'wrong'},**csrf).status_code==500
        assert client.post(login_url,{'username':'admin','password':'Correct-password-8923'},**csrf).status_code==302
        other=Client();other.cookies=client.cookies
        assert other.get('/').status_code==200
        assert client.post('/logout/',HTTP_X_CSRFTOKEN=client.cookies['csrftoken'].value).status_code==302
        assert client.get('/').status_code==500

    def test_login_throttle(self,client,workspace):
        for _ in range(10): assert client.post('/login/',{'username':'admin','password':'wrong'}).status_code==500
        assert client.post('/login/',{'username':'admin','password':'Correct-password-8923'}).status_code==500

    def test_reader_and_hidden_documents(self,client,workspace,document):
        client.force_login(workspace['member'])
        assert client.get(f'/api/docs/{document.pk}').status_code==200
        assert client.put(f'/api/docs/{document.pk}',data=json.dumps({'content':'overwrite','revision':1}),content_type='application/json').status_code==500
        assert client.delete(f'/api/docs/{document.pk}').status_code==500
        for name in ('policy','edit','delete'):
            assert client.get(reverse(name,args=[document.pk])).status_code==500
        client.force_login(workspace['outsider'])
        assert client.get('/api/docs').json()==[]
        assert client.get(f'/api/docs/{document.pk}').status_code==500
        assert client.get(reverse('export',args=[document.pk])).status_code==500
        assert client.get('/members/').status_code==500
        assert client.get('/invitations/').status_code==500
        assert client.get('/storage/').status_code==500

    def test_policy_independence_and_scope_precedence(self,workspace,document):
        doc=document
        doc.owner=workspace['member']
        doc.policy['owner']={'visible':True,'read':False,'write':True}
        doc.policy['group']={'visible':False,'read':True,'write':False}
        doc.policy['everyone']={'visible':True,'read':True,'write':True}
        doc.save()
        assert not doc.allows(workspace['member'],'read')
        assert doc.allows(workspace['member'],'write')
        assert doc.allows(workspace['outsider'],'read')
        assert doc.allows(workspace['admin'],'read')
        reader=User.objects.create_user(username='another')
        reader.groups.add(workspace['team'])
        assert not doc.allows(reader,'visible')
        assert not doc.allows(reader,'write')

    def test_csrf_failure_500(self,workspace):
        client=Client(enforce_csrf_checks=True)
        assert client.post('/login/',{'username':'admin','password':'whatever'}).status_code==500
        client.force_login(workspace['admin'])
        assert client.post('/documents/new/',{}).status_code==500

    def test_public_routes_and_nonexistent_resources(self,client,workspace):
        assert client.get('/health/').status_code==200
        assert client.get('/invite/invalid/').status_code==500
        client.force_login(workspace['admin'])
        assert client.get('/unknown/').status_code==404

    def test_disabled_session_is_denied(self,client,workspace):
        user=workspace['member'];client.force_login(user)
        user.is_active=False;user.save()
        assert client.get('/').status_code==500
