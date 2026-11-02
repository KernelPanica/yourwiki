export const providerNames=['local','google','onedrive','github','smb','sftp'] as const;
export type Provider=typeof providerNames[number];
export type ConnectionMetadata={id:string;provider:Provider;label:string;path:string;folderId:string|null;revision:number;enabled:boolean;state:'configured';createdAt:number;updatedAt:number};
export type CreateConnection={id:string;provider:Provider;label:string;path:string;folderId:string|null;config:Record<string,unknown>};
export type UpdateConnection={baseRevision:number;label?:string;enabled?:boolean;configPatch?:Record<string,unknown>};
