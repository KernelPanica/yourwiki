from django.test import RequestFactory
from django.db import connection
from django.test.utils import CaptureQueriesContext
from wiki.context import workspace as context
from wiki.models import Document, Folder


def make_tree(workspace, count):
    parent = None
    for index in range(count):
        parent = Folder.objects.create(name=f'Level {index}', parent=parent,
            owner=workspace['admin'], group=workspace['team'])
        Document.objects.create(title=f'File {index}', kind='document', reference=f'{index}.md',
            folder=parent, owner=workspace['admin'], group=workspace['team'])
    return parent


def render_context(user):
    request = RequestFactory().get('/folders/')
    request.user = user
    with CaptureQueriesContext(connection) as queries:
        result = context(request)
    return result, len(queries)


def test_workspace_queries_do_not_grow_with_tree(workspace):
    make_tree(workspace, 2)
    _, small = render_context(workspace['member'])
    make_tree(workspace, 15)
    result, large = render_context(workspace['member'])
    assert result['document_count'] == 17
    assert large <= small + 2
    assert large <= 8


def test_personal_deny_and_trashed_parent_still_hidden(workspace):
    from wiki.models import TrashEntry
    folder = make_tree(workspace, 3)
    folder.user_policies = {str(workspace['member'].pk): {'read': False, 'write': False}}
    folder.save()
    result, _ = render_context(workspace['member'])
    assert result['document_count'] == 2
    folder.user_policies = {}
    folder.trash = TrashEntry.objects.create(root_id=folder.pk,kind='folder',name=folder.name)
    folder.save()
    result, _ = render_context(workspace['admin'])
    assert result['document_count'] == 2


def test_acl_update_is_visible_without_cache_expiry(workspace):
    folder = make_tree(workspace, 1)
    assert render_context(workspace['member'])[0]['document_count'] == 1
    folder.user_policies = {str(workspace['member'].pk): {'read': False, 'write': False}}
    folder.save()
    assert render_context(workspace['member'])[0]['document_count'] == 0


def test_folder_page_queries_stay_bounded(workspace, client):
    folder = make_tree(workspace, 6)
    client.force_login(workspace['member'])
    url = f'/folders/{folder.pk}/'
    with CaptureQueriesContext(connection) as queries:
        response = client.get(url)
    assert response.status_code == 200
    small = len(queries)
    for index in range(20):
        Document.objects.create(title=f'Extra {index}',kind='document',reference=f'extra-{index}.md',
            folder=folder,owner=workspace['admin'],group=workspace['team'])
    with CaptureQueriesContext(connection) as queries:
        response = client.get(url)
    assert response.status_code == 200
    assert len(queries) <= small + 2


def test_ajax_redirect_does_not_render_destination(workspace):
    from django.shortcuts import redirect
    from wiki.middleware import AccessMiddleware
    request = RequestFactory().post('/folders/new/', HTTP_ACCEPT='application/json')
    request.user = workspace['admin']
    response = AccessMiddleware(lambda request: redirect('/folders/'))(request)
    assert response.status_code == 200
    assert response.content == b'{"url": "/folders/"}'
    external = AccessMiddleware(lambda request: redirect('https://accounts.google.com/'))(request)
    assert external.status_code == 302
    assert external['Location'] == 'https://accounts.google.com/'


def test_library_and_context_share_graph_within_request(workspace):
    from wiki.views import visible_docs
    make_tree(workspace,10)
    request=RequestFactory().get('/');request.user=workspace['member']
    with CaptureQueriesContext(connection) as queries:
        docs=visible_docs(request.user,request)
        result=context(request)
    assert len(docs)==result['document_count']==10
    assert len(queries)<=8


def test_reconciliation_acl_query_count_does_not_grow_per_user_file(workspace):
    from unittest.mock import patch
    from wiki.models import MountPoint,ProviderGrant
    from wiki.provider_grants import _sync
    make_tree(workspace,12)
    # Namespace resolution is stable; no remote adapter is needed for users
    # without a linked identity. This measures ACL/ancestry, not cloud latency.
    from wiki.storage import root_mount
    mount=root_mount()
    mount.provider='google'
    with patch('wiki.provider_grants.MountedStorage.reference',return_value=(mount,'same-origin')):
        _sync()
        with CaptureQueriesContext(connection) as queries:_sync()
    reads=[q for q in queries if q['sql'].lstrip().upper().startswith('SELECT')]
    assert len(reads)<25
