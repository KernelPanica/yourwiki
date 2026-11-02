/** PDF.js reports only the first modified transition until saveDocument resets it.
 * Compare its serialized storage hash to retain edits made while its worker saves.
 * This pinned PDF.js API is covered by a real-worker browser race regression.
 */
export async function serializePdf(
  pdf: { annotationStorage: { readonly serializable: { hash: string } }; saveDocument:()=>Promise<Uint8Array> },
  changed:()=>void,
) {
  const before=pdf.annotationStorage.serializable.hash;
  const bytes=await pdf.saveDocument();
  if(pdf.annotationStorage.serializable.hash!==before)changed();
  return bytes;
}
