/** Explicit mode is essential: supplying editorConfig customizations must not
 * leave ONLYOFFICE to fall back to its default edit mode for a read-only user. */
export function onlyofficeConfig(write:boolean){
 return {editorConfig:{mode:write?'edit':'view',customization:{forcesave:write,autosave:write}}};
}
