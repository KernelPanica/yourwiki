import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, realpath, stat, unlink, rm, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

export class BlobTooLargeError extends Error {
  constructor() { super('File exceeds the configured size limit'); }
}

export interface BlobRef { digest: string; size: number }
export interface ByteRange { start: number; end: number }

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function* interruptible(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      signal?.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        const aborted = signal ? new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }) : null;
        const next = aborted ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
        if (next.done) return;
        yield next.value;
      } finally { if (abort) signal!.removeEventListener('abort', abort); }
    }
  } finally {
    // Closing an untrusted source must never retain our file descriptor or
    // staging bytes. Observe rejection, including synchronous return() errors.
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

/** Immutable private storage. The root is controlled by the administrator. */
export class BlobStore {
  private root: string;
  private constructor(root: string) { this.root = root; }

  static async open(root: string): Promise<BlobStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const resolved = await realpath(root);
    for (const name of ['blobs', 'staging']) await mkdir(join(resolved, name), { mode: 0o700, recursive: true });
    await syncDirectory(resolved);
    await syncDirectory(dirname(resolved));
    return new BlobStore(resolved);
  }

  private uploadPath(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid temporary upload ID');
    return join(this.root, 'uploads', id);
  }

  async uploadStore(id: string): Promise<BlobStore> {
    const path = this.uploadPath(id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Persist the namespace entry before any chunk receipt can be committed.
    await syncDirectory(this.root);
    return BlobStore.open(path);
  }

  async removeUpload(id: string): Promise<void> {
    const path = this.uploadPath(id);
    await rm(path, { recursive: true, force: true });
    await syncDirectory(dirname(path)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  /** Inspect only; unlike uploadStore this never recreates a removed namespace. */
  async existingUploadStore(id:string):Promise<BlobStore|null>{
    try{return new BlobStore(await realpath(this.uploadPath(id)));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }

  async *uploadNamespaces():AsyncGenerator<string>{
    let directory;try{directory=await opendir(join(this.root,'uploads'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    for await(const entry of directory)if(entry.isDirectory()&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name))yield entry.name;
  }

  /** Internal namespace reconciliation only. Files in staging are intentionally excluded. */
  async *completedBlobs():AsyncGenerator<BlobRef>{
    let directory;try{directory=await opendir(join(this.root,'blobs'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    for await(const prefix of directory){
      if(!prefix.isDirectory()||!/^[a-f0-9]{2}$/.test(prefix.name))continue;
      const entries=await opendir(join(this.root,'blobs',prefix.name));
      for await(const entry of entries)if(entry.isFile()&&/^[a-f0-9]{62}$/.test(entry.name))yield await this.stat(prefix.name+entry.name);
    }
  }

  /** Make a discovered complete namespace blob durable before reconstructing its receipt. */
  async syncPrepared(ref:BlobRef){
    const file=await open(this.path(ref.digest),'r');try{await file.sync();}finally{await file.close();}
    await syncDirectory(dirname(this.path(ref.digest)));await syncDirectory(join(this.root,'blobs'));await syncDirectory(this.root);await syncDirectory(dirname(this.root));
  }

  /** Verify and durably link prepared bytes. No original/reference is modified here. */
  async adopt(source:BlobStore,value:BlobRef,options:{signal?:AbortSignal}={}):Promise<BlobRef>{
    const ref={...value};options.signal?.throwIfAborted();
    if(!await source.verify(ref,options.signal))throw new Error('Prepared immutable blob is corrupt');
    options.signal?.throwIfAborted();const target=this.path(ref.digest);
    await mkdir(dirname(target),{recursive:true,mode:0o700});await syncDirectory(join(this.root,'blobs'));
    try{await link(source.path(ref.digest),target);}
    catch(error){
      if((error as NodeJS.ErrnoException).code==='EXDEV')return this.put(await source.read(ref.digest),{maxBytes:ref.size,signal:options.signal});
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!await this.verify(ref,options.signal))throw new Error('Existing immutable blob is corrupt');
    }
    await syncDirectory(dirname(target));options.signal?.throwIfAborted();return ref;
  }

  private path(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid blob digest');
    return join(this.root, 'blobs', digest.slice(0, 2), digest.slice(2));
  }

  async put(source: AsyncIterable<Uint8Array>, options: { maxBytes: number; signal?: AbortSignal }): Promise<BlobRef> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error('Invalid blob size limit');
    options.signal?.throwIfAborted();
    const temporary = join(this.root, 'staging', randomUUID() + '.part');
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      try {
        for await (const chunk of interruptible(source, options.signal)) {
          options.signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new Error('Blob chunks must be bytes');
          if (chunk.byteLength > options.maxBytes - size) throw new BlobTooLargeError();
          await file.writeFile(chunk);
          hash.update(chunk); size += chunk.byteLength;
        }
        options.signal?.throwIfAborted();
        await file.sync();
      } finally { await file.close(); }
      options.signal?.throwIfAborted();
      const ref = { digest: hash.digest('hex'), size };
      const target = this.path(ref.digest);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await syncDirectory(join(this.root, 'blobs'));
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await this.verify(ref)) throw new Error('Existing immutable blob is corrupt');
      }
      await syncDirectory(dirname(target));
      return ref;
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  /** Trusted native worker use only; never expose this path through the API. */
  async localFile(digest: string): Promise<string> {
    await this.stat(digest);
    return this.path(digest);
  }

  async stat(digest: string): Promise<BlobRef> {
    const info = await stat(this.path(digest));
    if (!info.isFile()) throw new Error('Blob is not a regular file');
    return { digest, size: info.size };
  }

  async read(digest: string, range?: ByteRange): Promise<Readable> {
    const info = await this.stat(digest);
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end >= info.size)) throw new Error('Invalid byte range');
    return createReadStream(this.path(digest), range);
  }

  async verify(ref: BlobRef,signal?:AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    // Invalid references are programmer/input errors, not a missing blob.
    this.path(ref.digest);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0) return false;
    try {
      if ((await this.stat(ref.digest)).size !== ref.size) return false;
      const hash = createHash('sha256');
      const stream=await this.read(ref.digest),abort=()=>stream.destroy(signal?.reason instanceof Error?signal.reason:new Error('Verification aborted'));
      signal?.addEventListener('abort',abort,{once:true});
      try{signal?.throwIfAborted();for await(const chunk of stream){signal?.throwIfAborted();hash.update(chunk);}signal?.throwIfAborted();return hash.digest('hex')===ref.digest;}
      finally{signal?.removeEventListener('abort',abort);stream.destroy();}
    } catch (error) {
      if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }
}
