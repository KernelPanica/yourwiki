/** Read at interaction time so an account preference change takes effect immediately. */
export function motionEnabled(){
 return document.documentElement.dataset.animations==='on'&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
}
