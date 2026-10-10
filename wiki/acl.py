"""Canonical Yourwiki permissions; provider sharing reconciles after commit."""
from django.core.exceptions import ValidationError, PermissionDenied
from django.http import Http404


class ResourcePermissionDenied(PermissionDenied):
    pass


class ResourceNotFound(Http404, PermissionDenied):
    pass


ACTIONS = ('read', 'write')
SCOPES = ('owner', 'group', 'everyone')


def normalize_rule(rule):
    rule = rule if isinstance(rule, dict) else {}
    # Legacy hidden rules must not become readable during migration.
    visible = rule.get('visible', True) is True
    write = visible and rule.get('write') is True
    return {'read': visible and (rule.get('read') is True or write), 'write': write}


def normalize_policy(policy):
    return {scope: normalize_rule((policy or {}).get(scope)) for scope in SCOPES}


def validate_rule(rule):
    if not isinstance(rule, dict) or set(rule) != set(ACTIONS) or any(type(v) is not bool for v in rule.values()):
        raise ValidationError('Permissions must contain boolean read and write fields.')
    return normalize_rule(rule)


def validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) != set(SCOPES):
        raise ValidationError('Invalid permission policy.')
    return {scope: validate_rule(policy[scope]) for scope in SCOPES}


def validate_group_policies(policies):
    from django.contrib.auth.models import Group
    if not isinstance(policies, dict):
        raise ValidationError('Invalid group permissions.')
    valid = {str(pk) for pk in Group.objects.values_list('pk', flat=True)}
    if not set(policies).issubset(valid):
        raise ValidationError('Choose existing groups.')
    return {key: validate_rule(rule) for key, rule in policies.items()}


def apply_api_access(item, data, user):
    """Validate the complete update before mutating the instance."""
    from django.contrib.auth.models import Group
    from django.core.exceptions import PermissionDenied
    keys = {'policy','group','group_policies','inherit_permissions'} & data.keys()
    if not keys:
        return []
    if not user.is_superuser:
        raise ResourcePermissionDenied
    values = {}
    if 'policy' in keys:
        values['policy'] = validate_policy(data['policy'])
    if 'group_policies' in keys:
        values['group_policies'] = validate_group_policies(data['group_policies'])
    if 'inherit_permissions' in keys:
        if type(data['inherit_permissions']) is not bool:
            raise ValidationError('Inheritance must be a boolean.')
        values['inherit_permissions'] = data['inherit_permissions']
    elif keys & {'policy', 'group_policies'}:
        values['inherit_permissions'] = False
    if 'group' in keys:
        group = Group.objects.filter(name=data['group']).first()
        if not group:
            raise ValidationError('Choose an existing group.')
        values['group'] = group
    for key,value in values.items():
        setattr(item,key,value)
    return list(values)


def settings_context(item, user):
    from django.contrib.auth.models import Group
    source = item.effective_source()
    result = {'can_policy':user.is_superuser, 'inherited_source': source if source != item and source.allows(user,'read') else None,
              'effective_policy':item.effective_policy()[0]}
    from .models import Document, ProviderGrant
    from .provider_grants import target, PROVIDERS
    from .storage import MountedStorage
    if isinstance(item, Document) and item.reference:
        mount, reference = MountedStorage().reference(item.reference)
        if mount.provider in PROVIDERS:
            result['provider_grants'] = ProviderGrant.objects.filter(provider=mount.provider, object_key=target(mount, reference)).select_related('user')
            if not user.is_superuser:
                result['provider_grants'] = result['provider_grants'].filter(user=user)
            result['external_provider'] = mount.provider
    if user.is_superuser:
        groups=list(Group.objects.order_by('name'))
        result.update(groups=groups, rules=[(scope,list(rule.items())) for scope,rule in normalize_policy(item.policy).items()],
            group_rows=[(group,normalize_rule(item.group_policies.get(str(group.pk))),str(group.pk) in item.group_policies) for group in groups])
    return result


def save_settings_access(item, data, user):
    from django.core.exceptions import PermissionDenied
    from django.contrib.auth.models import Group
    if not user.is_superuser:
        raise ResourcePermissionDenied
    group = Group.objects.filter(pk=data.get('group')).first()
    if not group:
        raise ValidationError('Choose an existing group.')
    policy = {scope: normalize_rule({action:data.get(f'{scope}.{action}')=='on' for action in ACTIONS}) for scope in SCOPES}
    grants = {str(g.pk):normalize_rule({action:data.get(f'group.{g.pk}.{action}')=='on' for action in ACTIONS})
              for g in Group.objects.all() if data.get(f'group.{g.pk}.enabled')=='on'}
    item.group=group;item.policy=policy;item.group_policies=grants
    item.inherit_permissions=data.get('inherit_permissions')=='on'
    item.save(update_fields=['group','policy','group_policies','inherit_permissions'])
