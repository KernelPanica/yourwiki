def add_headers(headers, path, url):
    if '/drawio/' in url:
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
        headers['Referrer-Policy'] = 'no-referrer'
