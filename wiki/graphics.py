"""Materialize additive canvas movement without exporting collaboration metadata."""
import math
from django.core.exceptions import ValidationError


def canvas_nodes(data):
    nodes = []
    translations = data.get('translations', {})
    if not isinstance(translations, dict):
        raise ValidationError('Invalid canvas movement.')
    for key, node in data.get('nodes', {}).items():
        moved = dict(node)
        operations = translations.get(key, {})
        if not isinstance(operations, dict) or len(operations) > 10000:
            raise ValidationError('Canvas movement history is too large. Reload after saving.')
        for axis in ('x', 'y'):
            values = [node.get(axis, 0)]
            for operation in operations.values():
                value = operation.get(axis, 0) if isinstance(operation, dict) else None
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValidationError('Invalid canvas movement.')
                values.append(value)
            try:
                moved[axis] = math.fsum(values)
            except (TypeError, ValueError, OverflowError):
                raise ValidationError('Invalid canvas coordinates.') from None
            if not math.isfinite(moved[axis]):
                raise ValidationError('Invalid canvas coordinates.')
        nodes.append(moved)
    return nodes
