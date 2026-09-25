from django.urls import path
from wiki import views
from wiki import folders
from wiki import editor_views
from wiki import administration
from wiki import mounts
urlpatterns = [
    path('documents/<uuid:id>/live/', editor_views.live, name='live'),
    path('api/docs/<uuid:id>/status', editor_views.status),
    path('api/docs/<uuid:id>/metadata', editor_views.metadata),
    path('api/docs/<uuid:id>/reviews', editor_views.reviews),
    path('api/docs/<uuid:id>/reviews/<int:review_id>', editor_views.resolve_review),
    path('api/docs/<uuid:id>/attachments', editor_views.upload_attachment),
    path('attachments/<uuid:id>/', editor_views.attachment),
    path('folders/new/', folders.create_directory, name='new-directory'),
    path('folders/', folders.folder_page, name='folders'),
    path('folders/<uuid:id>/', folders.folder_page, name='folder'),
    path('folders/<uuid:id>/permissions/', folders.folder_policy, name='folder-policy'),
    path('move/<str:kind>/<uuid:id>/', folders.move, name='move'),
    path('api/folders', folders.api_folders),
    path('', views.library, name='library'),
    path('health/', views.health, name='health'),
    path('login', views.sign_in),
    path('login/', views.sign_in, name='login'),
    path('logout/', views.sign_out, name='logout'),
    path('documents/new/', views.editor, name='new'),
    path('files/upload/', views.upload_file, name='upload'),
    path('documents/import/', views.import_document, name='import'),
    path('documents/<uuid:id>/', views.detail, name='document'),
    path('documents/<uuid:id>/edit/', views.editor, name='edit'),
    path('documents/<uuid:id>/export/', views.export_document, name='export'),
    path('documents/<uuid:id>/delete/', views.remove, name='delete'),
    path('documents/<uuid:id>/star/', views.star, name='star'),
    path('documents/<uuid:id>/permissions/', views.policy, name='policy'),
    path('permissions/', views.permissions, name='permissions'),
    path('invitations/', views.invitations, name='invitations'),
    path('invitations/<int:id>/revoke/', views.revoke, name='revoke'),
    path('invite/<str:token>/', views.redeem, name='redeem'),
    path('members/', views.members, name='members'),
    path('groups/', views.groups, name='groups'),
    path('members/<int:id>/', views.member, name='member'),
    path('storage/', mounts.mountpoints, name='storage'),
    path('mounts/', mounts.mountpoints, name='mountpoints'),
    path('settings/', administration.site_admin, name='settings'),
    path('account/', views.account, name='account'),
    path('api/docs', views.api_documents),
    path('api/docs/<uuid:id>', views.api_document),
]
handler403 = views.denied
handler500 = lambda request: views.failure(request, 'The request could not be completed.', 500)
