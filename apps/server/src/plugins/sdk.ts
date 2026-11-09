/** Copy these types into a single .ts plugin file, or use an import type while developing. */
export type PluginField={key:string;label:string;type:'text'|'secret'|'url'|'textarea';required?:boolean};
export type PluginAction={id:string;label:string;description?:string;fields?:PluginField[]};
export type PluginContext={action:string;config:Record<string,string>;input:Record<string,string>;user:{id:string};fetch:typeof globalThis.fetch};
export type ServicePlugin={id:string;name:string;version:string;description?:string;fields?:PluginField[];actions:PluginAction[];execute:(context:PluginContext)=>unknown|Promise<unknown>};
