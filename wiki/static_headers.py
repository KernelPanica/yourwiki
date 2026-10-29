import re


def add_headers(headers, path, url):
    # esbuild content hashes change whenever a chunk or font asset changes.
    if re.search(r'-[A-Z0-9_-]{8}\.(?:js|css|woff2?|ttf)$', url):
        headers['Cache-Control']='public, max-age=31536000, immutable'
    if '/drawio/' in url:
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
        headers['Referrer-Policy'] = 'no-referrer'
