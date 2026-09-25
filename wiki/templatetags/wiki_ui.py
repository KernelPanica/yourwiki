from django import template
from django.utils.html import format_html
register=template.Library()
PATHS={
'book':'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h3z',
'grid':'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
'star':'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
'clock':'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
'folder':'M3 7V5h6l2 2h10v13H3z',
'cloud':'M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-1 5 5 0 0 1 0 11z',
'shield':'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
'users':'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M13 4a4 4 0 1 1 0 7 M22 21v-3a4 4 0 0 0-4-4 M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
'plus':'M12 5v14 M5 12h14',
'arrow':'M4 12h16 M14 6l6 6-6 6',
'chevron':'m9 5 7 7-7 7',
'document':'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
'table':'M3 4h18v16H3z M3 10h18 M9 4v16 M15 4v16',
'drawio':'M9 2h6v5H9z M2 17h6v5H2z M16 17h6v5h-6z M12 7v5 M5 17v-5h14v5',
'canvas':'M3 3h7v6H3z M14 15h7v6h-7z M6 9v9h8 M14 4h7v6h-7z',
'search':'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
'upload':'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
'download':'M12 3v13 M7 11l5 5 5-5 M4 17v4h16v-4',
'edit':'m4 16 12-12 4 4L8 20H4z',
'check':'m5 12 4 4L19 6',
'settings':'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
'list':'M8 5h13 M8 12h13 M8 19h13 M3 5h1 M3 12h1 M3 19h1',
'close':'M6 6l12 12 M18 6 6 18',
'return':'M20 5v7a4 4 0 0 1-4 4H5 M10 11l-5 5 5 5',
'back':'M20 12H4 M10 6l-6 6 6 6',
'zoom-in':'M12 8v8 M8 12h8 M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
'zoom-out':'M8 12h8 M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0'}
@register.simple_tag
def icon(name):
    return format_html('<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="{}"/></svg>', PATHS.get(name,PATHS['document']))
