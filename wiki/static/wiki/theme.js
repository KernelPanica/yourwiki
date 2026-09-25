(() => {
  const root = document.documentElement;
  const controls = () => document.querySelectorAll('[data-theme-toggle]');
  const apply = theme => {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem('yourwiki-theme', root.dataset.theme); } catch {}
    controls().forEach(control => {
      const dark = root.dataset.theme === 'dark';
      control.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
      if (control.matches('input')) control.checked = dark;
      else control.textContent = dark ? 'Light theme' : 'Dark theme';
    });
  };
  let saved = 'light';
  try { saved = localStorage.getItem('yourwiki-theme') || 'light'; } catch {}
  apply(saved);
  document.addEventListener('change', event => {
    if (event.target.matches('[data-theme-toggle]')) apply(event.target.checked ? 'dark' : 'light');
  });
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-theme-toggle]');
    if (control && !control.matches('input')) apply(root.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  window.addEventListener('storage', event => { if (event.key === 'yourwiki-theme') apply(event.newValue); });
})();
