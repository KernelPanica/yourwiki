"""Link an existing Yourwiki account to an OAuth-verified provider identity.
Tokens are used once for identification and never persisted.
"""
import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode, quote
from django import forms
from django.conf import settings
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction, IntegrityError
from django.shortcuts import render, redirect
from django.urls import reverse
from django.utils import timezone
from django.utils.translation import gettext_lazy as _
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods, require_POST
from .acl import ResourcePermissionDenied
from .crypto import encrypt, decrypt
from .models import Document, ProviderIdentity, ProviderGrant, SiteConfiguration
from .provider_grants import PROVIDERS, sync_provider_grants, target
from .storage import HTTP, MountedStorage
from .views import guarded

LABELS={'google':'Google Drive','onedrive':'OneDrive','github':'GitHub'}


class ClientForm(forms.Form):
    provider=forms.ChoiceField(label=_("Provider"),choices=list(LABELS.items()))
    client_id=forms.CharField(label=_("Client ID"),max_length=255)
    client_secret=forms.CharField(label=_("Client secret"),max_length=4096,widget=forms.PasswordInput(render_value=False))
    tenant=forms.RegexField(r'^[A-Za-z0-9.-]+$',label=_("Microsoft tenant"),max_length=255,required=False,initial='common')


def clients():
    site=SiteConfiguration.current()
    result=decrypt(site.encrypted_identity_oauth_clients) if site.encrypted_identity_oauth_clients else {}
    if 'google' not in result and site.encrypted_google_oauth_client:
        result['google']=decrypt(site.encrypted_google_oauth_client)
    return result


@guarded
@require_http_methods(['GET','POST'])
def setup(request):
    if not request.user.is_authenticated: raise ResourcePermissionDenied
    if not request.user.provider_setup_required: return redirect('library')
    from .onboarding import required_providers
    required=required_providers(request.user)
    configured=clients()
    identities={identity.provider:identity for identity in request.user.provider_identities.filter(active=True)}
    missing=[provider for provider in required if provider not in identities]
    error=''
    if request.method=='POST':
        if missing:
            error=_('Connect every required provider account before continuing.')
        else:
            try:
                sync_provider_grants(force=True)
            except Exception:
                error=_('Access synchronization is unavailable. Retry or contact an administrator.')
            if not error:
                blocked=ProviderGrant.objects.filter(user=request.user,provider__in=required).exclude(desired_role='').exclude(status='synced').exists()
                if blocked:
                    error=_('Provider access is not ready. Check the permissions below, accept any invitation, then retry.')
                else:
                    request.user.provider_setup_required=False
                    request.user.save(update_fields=['provider_setup_required'])
                    return redirect('library')
    grants=ProviderGrant.objects.filter(user=request.user,provider__in=required).exclude(desired_role='').order_by('provider','pk')
    rows=[{'provider':provider,'label':LABELS[provider],'configured':provider in configured,'identity':identities.get(provider)} for provider in required]
    return render(request,'wiki/provider_setup.html',{'rows':rows,'grants':grants,'setup_error':error,'can_finish':not missing},status=400 if error else 200)


def callback_uri(provider):
    return settings.PUBLIC_URL.rstrip('/')+reverse('identity-callback',args=[provider])


def endpoints(provider,config):
    if provider=='google':
        return ('https://accounts.google.com/o/oauth2/v2/auth','https://oauth2.googleapis.com/token','openid email profile')
    if provider=='onedrive':
        base='https://login.microsoftonline.com/'+quote(config.get('tenant') or 'common',safe='')+'/oauth2/v2.0/'
        return (base+'authorize',base+'token','openid profile User.Read')
    return ('https://github.com/login/oauth/authorize','https://github.com/login/oauth/access_token','read:user user:email')


def exchange_identity(provider,pending,code):
    config=pending['config'];http=HTTP({})
    _,token_url,scope=endpoints(provider,config)
    result=http.request('POST',token_url,headers={'Accept':'application/json'},data={
        'grant_type':'authorization_code','client_id':config['client_id'],'client_secret':config['client_secret'],
        'redirect_uri':pending['redirect_uri'],'code':code,'code_verifier':pending['verifier']}).json()
    token=result.get('access_token')
    if not token:raise ValidationError('Provider authorization failed. Start again.')
    headers={'Authorization':'Bearer '+token,'Accept':'application/json'}
    url={'google':'https://openidconnect.googleapis.com/v1/userinfo','onedrive':'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName','github':'https://api.github.com/user'}[provider]
    profile=http.request('GET',url,headers=headers).json()
    if provider=='google':
        if profile.get('email_verified') not in (True,'true'):raise ValidationError('The provider email must be verified.')
        identity={'external_id':profile.get('sub'),'email':profile.get('email'),'login':''}
    elif provider=='onedrive':
        identity={'external_id':profile.get('id'),'email':profile.get('mail') or profile.get('userPrincipalName'),'login':''}
    else:
        identity={'external_id':str(profile.get('id') or ''),'email':'','login':profile.get('login')}
    if not identity['external_id'] or len(identity['external_id'])>255:
        raise ValidationError('The provider did not return a valid account identity.')
    if provider!='github':validate_email(identity['email'] or '')
    elif not identity['login'] or len(identity['login'])>255:raise ValidationError('Invalid GitHub account.')
    return identity


@guarded
@require_http_methods(['GET','POST'])
@sensitive_post_parameters('client_secret')
def accounts(request):
    form=ClientForm(request.POST or None)
    if request.method=='POST':
        if not request.user.is_superuser:raise ResourcePermissionDenied
        if form.is_valid():
            config=clients();data=form.cleaned_data.copy();provider=data.pop('provider');config[provider]=data
            site=SiteConfiguration.current();site.encrypted_identity_oauth_clients=encrypt(config);site.save()
            messages.success(request,'OAuth client saved. Register the callback URL shown below with the provider.')
            return redirect('provider-accounts')
    configured=clients()
    identities={i.provider:i for i in request.user.provider_identities.filter(active=True)}
    rows=[{'provider':p,'label':LABELS[p],'configured':p in configured,'identity':identities.get(p),'callback':callback_uri(p)} for p in PROVIDERS]
    grants=ProviderGrant.objects.select_related('user','mount')
    if not request.user.is_superuser:grants=grants.filter(user=request.user).exclude(desired_role='')
    visible = {}
    for doc in Document.objects.exclude(reference='').select_related('folder','owner','group'):
        if doc.allows(request.user,'read'):
            mount, reference = MountedStorage().reference(doc.reference)
            if mount.provider in PROVIDERS:
                visible.setdefault((mount.provider,target(mount,reference)),doc)
    displayed = []
    for grant in grants.order_by('status','pk'):
        doc = visible.get((grant.provider,grant.object_key))
        if not doc and not request.user.is_superuser:
            continue
        grant.resource_title = doc.title if doc else _('Original no longer in the workspace')
        grant.resource_url = reverse('document',args=[doc.pk]) if doc else ''
        displayed.append(grant)
    return render(request,'wiki/provider_accounts.html',{'rows':rows,'client_form':form,'grants':displayed,'section':'Settings'},status=400 if form.errors else 200)


@guarded
@require_POST
def connect(request,provider):
    if provider not in PROVIDERS:raise ValidationError('Unknown provider.')
    config=clients().get(provider)
    if not config:raise ValidationError('Ask an administrator to configure this OAuth client first.')
    verifier=secrets.token_urlsafe(48);state=secrets.token_urlsafe(32)
    pending={'state':state,'verifier':verifier,'created':time.time(),'user':request.user.pk,'config':config,'redirect_uri':callback_uri(provider)}
    request.session['identity_oauth_'+provider]=encrypt(pending)
    authorize,_,scope=endpoints(provider,config)
    query={'client_id':config['client_id'],'redirect_uri':pending['redirect_uri'],'response_type':'code','scope':scope,'state':state,
        'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode(),'code_challenge_method':'S256'}
    return redirect(authorize+'?'+urlencode(query))


@guarded
@require_http_methods(['GET','POST'])
@sensitive_post_parameters('code')
def callback(request,provider):
    if provider not in PROVIDERS:raise ValidationError('Unknown provider.')
    if request.method=='GET':
        return render(request,'wiki/identity_callback.html',{'provider':provider,'label':LABELS[provider],'code':request.GET.get('code','')[:4096],'state':request.GET.get('state','')[:128],'oauth_error':bool(request.GET.get('error'))})
    if not request.user.is_authenticated:raise ResourcePermissionDenied
    value=request.session.get('identity_oauth_'+provider)
    if not value:raise ValidationError('Authorization expired or was already used. Start again.')
    pending=decrypt(value)
    if not secrets.compare_digest(request.POST.get('state','')[:129],pending['state']) or pending['user']!=request.user.pk:raise ResourcePermissionDenied
    name=request.POST.get('display_name','').strip()
    if not name or len(name)>150:raise ValidationError('Enter your display name (up to 150 characters).')
    del request.session['identity_oauth_'+provider];request.session.save()
    if not 0<=time.time()-pending['created']<=600:raise ValidationError('Authorization expired. Start again.')
    code=request.POST.get('code','')
    if not code or len(code)>4096:raise ValidationError('Authorization was cancelled. Start again.')
    identity=exchange_identity(provider,pending,code)
    try:
        with transaction.atomic():
            # Unique provider subject prevents borrowing somebody else's identity.
            ProviderIdentity.objects.update_or_create(user=request.user,provider=provider,defaults={**identity,'active':True,'verified_at':timezone.now()})
            request.user.display_name=name;request.user.save(update_fields=['display_name'])
    except IntegrityError:
        raise ValidationError('This provider account is already linked to another user.') from None
    return redirect('provider-setup' if request.user.provider_setup_required else 'provider-accounts')


@guarded
@require_POST
def unlink(request,provider):
    identity=ProviderIdentity.objects.filter(user=request.user,provider=provider,active=True).first()
    if identity:
        identity.active=False;identity.save(update_fields=['active'])
    return redirect('provider-setup' if request.user.provider_setup_required else 'provider-accounts')


@guarded
@require_POST
def retry(request):
    if not request.user.is_superuser:raise ResourcePermissionDenied
    sync_provider_grants(force=True)
    messages.info(request,'Synchronization finished. Check pending and failed permissions below.')
    return redirect('provider-accounts')
