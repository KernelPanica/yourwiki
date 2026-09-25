from django import forms
from django.conf import settings
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db.models import F
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods
from .models import SiteConfiguration, Collaboration, PendingDeletion
from .views import guarded


class SiteForm(forms.ModelForm):
    class Meta:
        model = SiteConfiguration
        exclude = ['id', 'default_document_policy', 'default_collection']
        labels = {'name':'Workspace name','description':'Workspace description','session_hours':'Session lifetime (hours)',
            'invite_days':'Default invitation lifetime (days; 0 = no expiry)','invite_uses':'Default invitation uses (0 = unlimited)',
            'login_attempts':'Login attempts per window','login_window_minutes':'Login rate-limit window (minutes)',
            'document_limit_mb':'Document size limit (MB)','image_limit_mb':'Image upload limit (MB)',
            'image_limit_megapixels':'Maximum image size (megapixels)','sync_interval_seconds':'Storage synchronization interval (seconds)',
            }

    def clean(self):
        data=super().clean()
        limits={'session_hours':(1,720),'invite_days':(0,3650),'invite_uses':(0,100000),'login_attempts':(1,100),
            'login_window_minutes':(1,1440),'document_limit_mb':(1,5),'image_limit_mb':(1,5),'image_limit_megapixels':(1,16),'sync_interval_seconds':(1,60)}
        for key,(minimum,maximum) in limits.items():
            if key in data and not minimum<=data[key]<=maximum:
                self.add_error(key,f'Use a value between {minimum} and {maximum}.')
        return data


@guarded
@require_http_methods(['GET','POST'])
def site_admin(request):
    if not request.user.is_superuser:
        raise PermissionDenied
    config=SiteConfiguration.current()
    form=SiteForm(request.POST or None,instance=config)
    if request.method=='POST' and form.is_valid():
        saved=form.save(commit=False)
        saved.default_document_policy={s:{a:request.POST.get(s+'.'+a)=='on' for a in ('visible','read','write')} for s in ('owner','group','everyone')}
        saved.save()
        messages.success(request,'Site settings saved. Session lifetime applies at the next sign-in; defaults apply to new documents.')
        return redirect('settings')
    return render(request,'wiki/site_admin.html',{'section':'Site administration','form':form,
        'rules':[(s,list(rule.items())) for s,rule in config.default_document_policy.items()],
        'public_url':settings.PUBLIC_URL,'allowed_hosts':', '.join(settings.ALLOWED_HOSTS),
        'database_path':str(settings.DATABASES['default']['NAME']),'secure_cookies':settings.SESSION_COOKIE_SECURE,
        'pending_sync':Collaboration.objects.exclude(sequence=F('synced_sequence')).count(),
        'pending_deletions':PendingDeletion.objects.count()},status=400 if form.errors else 200)
