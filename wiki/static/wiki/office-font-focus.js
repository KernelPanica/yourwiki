/* Restore document input after a confirmed Collabora font selection.
 * The editor remains responsible for applying the font and checking write access.
 */
(() => {
  function attach(frame, focus, writable) {
    if (!writable) return () => {};
    let document;
    try {document=frame.contentDocument;} catch {return () => {};}
    if (!document) return () => {};
    let timer;
    function fontControl(target) {
      if (!target?.closest) return false;
      const control=target.closest('.ui-combobox');
      return control?.id==='fontnamecombobox';
    }
    function fontEntry(target) {
      return !!target?.closest?.('[id^="fontnamecombobox-entry-"]');
    }
    function fontSearch(target) {
      return target?.matches?.('.ui-combobox-search-input') && !!target.closest('[id^="fontnamecombobox"].modalpopup');
    }
    function restore() {
      clearTimeout(timer);
      // Let Collabora apply the choice and finish closing its dropdown first.
      timer=setTimeout(focus,0);
    }
    function click(event) {
      if(event.button===0 && fontEntry(event.target)) restore();
    }
    function key(event) {
      if(event.key==='Enter' && (fontControl(event.target)||fontEntry(event.target)||fontSearch(event.target))) restore();
    }
    document.addEventListener('click',click,true);
    document.addEventListener('keyup',key,true);
    document.addEventListener('keydown',eventKeyDown,true);
    function eventKeyDown(event) {
      // Search Enter selects/removes the dropdown before keyup reaches it.
      if(event.key==='Enter' && fontSearch(event.target)) restore();
    }
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click',click,true);
      document.removeEventListener('keyup',key,true);
      document.removeEventListener('keydown',eventKeyDown,true);
    };
  }
  window.yourwikiOfficeFontFocus={attach};
})();
