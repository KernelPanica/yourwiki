"""Sleek palette contrast and persisted, accessible theme switching."""
import os
import pytest
from playwright.sync_api import expect, sync_playwright
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def contrast(a, b):
    def luminance(color):
        if len(color) == 4: color = "#" + "".join(c*2 for c in color[1:])
        parts = [int(color[i:i+2], 16)/255 for i in (1, 3, 5)]
        linear = [v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in parts]
        return sum(v*w for v, w in zip(linear, (.2126, .7152, .0722)))
    low, high = sorted((luminance(a), luminance(b)))
    return (high+.05)/(low+.05)


def test_theme_contrast_and_persistence(realtime_server, workspace):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440,'height':900})
        page.goto(realtime_server + '/login/')
        switch = page.locator('[data-theme-toggle]')
        for theme in ('dark', 'light'):
            switch.click()
            expect(page.locator('html')).to_have_attribute('data-theme', theme)
            expect(switch).to_have_attribute('aria-pressed', str(theme == 'dark').lower())
            page.reload()
            expect(page.locator('html')).to_have_attribute('data-theme', theme)
            expect(switch).to_have_attribute('aria-label', 'Use light theme' if theme == 'dark' else 'Use dark theme')
            page.evaluate('document.fonts.ready')
            assert page.evaluate('document.fonts.check("16px Inter")')
            tokens = page.evaluate('''() => {
              const s = getComputedStyle(document.documentElement);
              return Object.fromEntries(['text','muted','soft','primary','primary-ink','danger','focus','bg','panel','surface','hover','line'].map(k => [k,s.getPropertyValue('--'+k).trim()]));
            }''')
            for foreground in ('text','muted','soft','primary-ink','danger'):
                for background in ('bg','panel','surface','hover'):
                    assert contrast(tokens[foreground],tokens[background]) >= 4.5, (theme,foreground,background)
            assert contrast('#ffffff', tokens['primary']) >= 4.5
            for background in ('bg','panel','surface'):
                assert contrast(tokens['focus'],tokens[background]) >= 3
                assert contrast(tokens['line'],tokens[background]) >= 3
            switch.focus()
            assert page.locator('[data-theme-toggle]').evaluate('(e) => getComputedStyle(e).outlineStyle') != 'none'
            page.screenshot(path=f'/tmp/yourwiki-sleek-login-{theme}.png', full_page=True)
        login(page, realtime_server, 'admin')
        page.locator('.workspace-menu > summary').click()
        page.locator('[data-theme-toggle]').click()
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        page.goto(realtime_server + '/account/')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        page.locator('.workspace-menu > summary').click()
        expect(page.locator('[data-theme-toggle]')).to_have_attribute('aria-label', 'Use light theme')
        browser.close()
