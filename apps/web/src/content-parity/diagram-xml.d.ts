/** Lossless codec copied from frontend/diagram-xml.js so the v2 web build is self-contained. */
export type DiagramData={xml:Record<string,unknown>;pages:Record<string,Record<string,any>>;order:string[]};
export function diagramData(xml:string,options?:{parse?:(source:string)=>Document;decompress?:(source:string)=>string;previous?:DiagramData}):DiagramData;
export function diagramXML(data:DiagramData):string;
