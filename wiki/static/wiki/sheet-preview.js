(() => {
  const host = document.querySelector('[data-sheet-preview]');
  if (!host) return;
  const sheets = JSON.parse(document.getElementById('sheet-preview-data').textContent);
  const tabs = [...host.querySelectorAll('[role="tab"]')];
  const panel = host.querySelector('[role="tabpanel"]');
  const table = host.querySelector('table');
  const translate = window.gettext || (text => text);
  const format = window.interpolate || ((text, values) => text.replace(/%\((\w+)\)s/g, (_, key) => values[key]));
  const cell = (tag, value, scope) => {
    const element = document.createElement(tag);
    element.textContent = value ?? '';
    if (scope) element.scope = scope;
    return element;
  };
  function select(index, focus = false, render = true) {
    const sheet = sheets[index];
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[index].id);
    table.setAttribute('aria-label', sheet.name);
    if (render) {
      const head = document.createElement('thead'), heading = document.createElement('tr');
      const corner = cell('th', '');
      corner.className = 'sheet-corner';
      corner.setAttribute('aria-label', translate('Row numbers'));
      heading.append(corner, ...sheet.columns.map(label => cell('th', label, 'col')));
      head.append(heading);
      const body = document.createElement('tbody');
      sheet.rows.forEach((values, row) => {
        const tr = document.createElement('tr');
        tr.append(cell('th', row + 1, 'row'), ...values.map(value => cell('td', value)));
        body.append(tr);
      });
      table.replaceChildren(head, body);
      panel.scrollTop = panel.scrollLeft = 0;
    }
    host.querySelector('[data-sheet-count]').textContent = format(translate('%(rows)s rows · %(columns)s columns'), {rows: sheet.row_count, columns: sheet.column_count}, true);
    host.querySelector('[data-sheet-limit]').hidden = !sheet.truncated;
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      let target;
      if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = tabs.length - 1;
      if (target !== undefined) { event.preventDefault(); select(target, true); }
    });
  });
  select(0, false, false);
})();
