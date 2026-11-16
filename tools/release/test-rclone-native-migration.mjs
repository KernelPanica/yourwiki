import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../apps/server/src/database.ts";
import { BlobStore } from "../../apps/server/src/storage/blobs.ts";
import { DocumentService } from "../../apps/server/src/documents.ts";
import { createSession } from "../../apps/server/src/auth/sessions.ts";
async function* bytes(value) {
  yield value;
}
async function historyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wiki-native-migration-")), db = openDatabase(join(root, "database.sqlite3")), store = await BlobStore.open(join(root, "storage")), docs = new DocumentService(db, store);
  db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('writer','writer','Writer','!','member'),('reader','reader','Reader','!','member'),('foreign','foreign','Foreign','!','member'),('admin','admin','Admin','!','giga');INSERT INTO groups(id,name) VALUES('g','Group');INSERT INTO memberships VALUES('writer','g'),('reader','g')");
  const sessions = Object.fromEntries(["writer", "reader", "foreign", "admin"].map((id) => [id, createSession(db, id)]));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, store, docs, sessions, async publish() {
    db.exec("UPDATE documents SET published_revision=local_revision");
  } };
}
import { blankOfficeSource } from "../../apps/server/src/office/blank.ts";
import { bindExistingSource } from "../../apps/server/src/providers/source-bindings.ts";
import { NativeMigration } from "../../apps/server/src/rclone/native-migration.ts";
import { rcloneFingerprint } from "../../apps/server/src/rclone/client.ts";
import { OfficeSessions } from "../../apps/server/src/office/sessions.ts";
async function fixture(t, format = "docx") {
  const f = await historyFixture(t), data = await blankOfficeSource(format), created = await f.docs.create({ userId: "writer", groupId: "g", parentId: null, title: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442", format }, bytes(data));
  await f.publish();
  f.db.exec("INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES('drive','google','Drive','encrypted',1,1);INSERT INTO rclone_drive_mounts(connection_id,binary_path,config_path,mount_path,staging_path) VALUES('drive','/bin/false','/private/config','/private/mount','/private/stage')");
  const original = { ID: "google-original", Path: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442.docx", Name: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442", Size: -1, MimeType: "application/vnd.google-apps." + { docx: "document", xlsx: "spreadsheet", pptx: "presentation" }[format], IsDir: false, ModTime: "2026-11-14T00:00:00Z", Hashes: {} };
  bindExistingSource(f.db, { documentId: created.documentId, connectionId: "drive", reference: original.ID, fingerprint: rcloneFingerprint(original), confirmedRevision: 1, confirmedDigest: created.blob.digest, confirmedSize: created.blob.size, now: Date.now() });
  const entries = [original];
  let uploads = 0;
  const client = { async list() {
    return entries;
  }, async stat(path) {
    const e = entries.find((e2) => e2.Path === path);
    assert(e);
    return e;
  }, async upload(_local, path, _scope, immutable) {
    assert.equal(immutable, true);
    uploads++;
    const e = { ...original, ID: "binary-copy", Path: path, Name: path, Size: data.length, MimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Hashes: { md5: createHash("md5").update(data).digest("hex") } };
    entries.push(e);
    return e;
  } };
  return { ...f, created, original, entries, client, uploads: () => uploads, migration: new NativeMigration(f.db, f.store), scope: { check() {
  } } };
}
test("verified cutover preserves document identity, permissions and original; native file is never uploaded over", async (t) => {
  const f = await fixture(t), id = f.created.documentId, office = new OfficeSessions(f.db), before = office.open(f.sessions.writer.token, id, true);
  assert.equal(before.write, false);
  const resource = f.db.prepare("SELECT * FROM resources WHERE id=?").get(id);
  assert.equal(await f.migration.migrate(id, f.client, f.scope), "migrated");
  assert.equal(f.uploads(), 1);
  assert.equal(f.entries[0], f.original);
  assert.deepEqual(f.db.prepare("SELECT * FROM resources WHERE id=?").get(id), resource);
  assert.equal(f.db.prepare("SELECT reference FROM provider_source_bindings WHERE document_id=?").get(id).reference, "binary-copy");
  const writer = office.open(f.sessions.writer.token, id, true);
  assert.equal(writer.write, true);
  assert.throws(() => office.open(f.sessions.foreign.token, id, true), { code: "NOT_FOUND" });
  const reader = office.open(f.sessions.reader.token, id, true);
  assert.equal(reader.write, false);
  office.release(f.sessions.writer.token, writer.sessionId, writer.token);
  office.release(f.sessions.reader.token, reader.sessionId, reader.token);
  assert.equal(await f.migration.migrate(id, f.client, f.scope), "already");
  assert.equal(f.uploads(), 1);
  await f.docs.save({ userId: "writer", documentId: id, baseRevision: 1 }, bytes(await blankOfficeSource("docx")));
  assert.equal(f.db.prepare("SELECT requested_revision FROM provider_delivery_requests WHERE document_id=?").get(id).requested_revision, 2);
  assert.throws(() => f.db.prepare("UPDATE provider_source_bindings SET reference='arbitrary' WHERE document_id=?").run(id), /immutable/);
});
test("remote change during upload leaves original binding and retry never overwrites a changed binary copy", async (t) => {
  const f = await fixture(t), id = f.created.documentId, upload = f.client.upload;
  f.client.upload = async (...args) => {
    const target = await upload(...args);
    f.original.ModTime = "2026-11-14T00:00:01Z";
    return target;
  };
  await assert.rejects(f.migration.migrate(id, f.client, f.scope), { code: "PROVIDER_CONFLICT" });
  assert.equal(f.db.prepare("SELECT reference FROM provider_source_bindings WHERE document_id=?").get(id).reference, f.original.ID);
  f.original.ModTime = "2026-11-14T00:00:00Z";
  f.entries[1].Hashes.md5 = "0".repeat(32);
  await assert.rejects(f.migration.migrate(id, f.client, f.scope), { code: "PROVIDER_CONFLICT" });
  assert.equal(f.uploads(), 1);
});
test("crash after upload is resumed using verified existing destination, without a duplicate", async (t) => {
  const f = await fixture(t), id = f.created.documentId, stat = f.client.stat;
  let crash = true;
  f.client.stat = async (path) => {
    if (crash && f.uploads() === 1) {
      crash = false;
      throw Error("simulated outage");
    }
    return stat(path);
  };
  await assert.rejects(f.migration.migrate(id, f.client, f.scope), /simulated outage/);
  assert.equal(await f.migration.migrate(id, f.client, f.scope), "migrated");
  assert.equal(f.uploads(), 1);
});
for (const format of ["xlsx", "pptx"]) test(format + " migration remains editable without changing local identity", async (t) => {
  const f = await fixture(t, format);
  assert.equal(await f.migration.migrate(f.created.documentId, f.client, f.scope), "migrated");
  assert.equal(new OfficeSessions(f.db).open(f.sessions.writer.token, f.created.documentId, true).write, true);
});
test("changed source snapshot cannot create a migration receipt", async (t) => {
  const f = await fixture(t);
  f.original.ModTime = "2026-11-14T01:00:00Z";
  await assert.rejects(f.migration.migrate(f.created.documentId, f.client, f.scope), { code: "PROVIDER_CONFLICT" });
  assert.equal(f.uploads(), 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM rclone_native_migrations").get().n, 0);
});
import { drainNativeMigrations } from "../../apps/server/src/rclone/storage-worker.ts";
test("background queue commits verified files and defers conflicts without blocking the whole batch", async (t) => {
  const f = await fixture(t), id = f.created.documentId;
  f.db.prepare("INSERT INTO rclone_native_queue(document_id,requested_at) VALUES(?,?)").run(id, Date.now());
  f.original.ModTime = "2026-11-14T01:00:00Z";
  await drainNativeMigrations(f.db, f.store, f.client, f.scope, f.entries, "drive");
  const deferred = f.db.prepare("SELECT * FROM rclone_native_queue WHERE document_id=?").get(id);
  assert.equal(deferred.error_code, "PROVIDER_CONFLICT");
  assert(deferred.next_attempt_at > Date.now());
  f.original.ModTime = "2026-11-14T00:00:00Z";
  f.db.prepare("UPDATE rclone_native_queue SET next_attempt_at=0").run();
  await drainNativeMigrations(f.db, f.store, f.client, f.scope, f.entries, "drive");
  assert.equal(f.db.prepare("SELECT 1 FROM rclone_native_queue").get(), void 0);
  assert.equal(f.uploads(), 1);
});
import { publishRcloneCatalogue } from "../../apps/server/src/rclone/storage-worker.ts";
import { NativeMigrationWorker } from "../../apps/server/src/rclone/native-worker.ts";
test("an older concurrent catalogue cannot erase a new migration binding; remote renames still work", async (t) => {
  const f = await fixture(t), id = f.created.documentId;
  await f.migration.migrate(id, f.client, f.scope);
  publishRcloneCatalogue(f.db, "drive", [f.original]);
  assert(f.db.prepare("SELECT 1 FROM rclone_drive_entries WHERE reference='binary-copy'").get());
  const target = f.entries[1], moved = { ...target, Path: "Renamed.docx" }, replacement = { ...target, ID: "another-file" };
  publishRcloneCatalogue(f.db, "drive", [f.original, moved, replacement]);
  assert.equal(f.db.prepare("SELECT path FROM rclone_drive_entries WHERE reference='binary-copy'").get().path, "Renamed.docx");
});
test("migration worker never consumes or releases the ordinary save/sync lease", async (t) => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO rclone_native_queue(document_id,requested_at) VALUES(?,?)").run(f.created.documentId, Date.now());
  f.db.prepare("INSERT INTO worker_slots VALUES('provider-source','ordinary-save',?)").run(Date.now() + 3e4);
  f.db.exec("INSERT INTO google_storage_mounts(connection_id,actor_id,group_id,connection_revision) VALUES('drive','admin','g',1)");
  assert.equal(await new NativeMigrationWorker(f.db, f.store).runOnce(), "deferred");
  assert.equal(f.db.prepare("SELECT token FROM worker_slots WHERE name='provider-source'").get().token, "ordinary-save");
  assert.equal(f.db.prepare("SELECT 1 FROM worker_slots WHERE name='native-migration'").get(), void 0);
});
test("a destination already bound to another wiki document cannot be adopted", async (t) => {
  const f = await fixture(t), other = await f.docs.create({ userId: "writer", groupId: "g", parentId: null, title: "Other", format: "docx" }, bytes(await blankOfficeSource("docx"))), upload = f.client.upload;
  f.client.upload = async (...args) => {
    const target = await upload(...args);
    bindExistingSource(f.db, { documentId: other.documentId, connectionId: "drive", reference: target.ID, fingerprint: rcloneFingerprint(target), confirmedRevision: 1, confirmedDigest: other.blob.digest, confirmedSize: other.blob.size, now: Date.now() });
    return target;
  };
  await assert.rejects(f.migration.migrate(f.created.documentId, f.client, f.scope), { code: "PROVIDER_CONFLICT" });
  assert.equal(f.db.prepare("SELECT reference FROM provider_source_bindings WHERE document_id=?").get(f.created.documentId).reference, f.original.ID);
});

import {queueImportedNativeMigration} from '../../apps/server/src/rclone/native-auto-migration.ts';
test('new native imports migrate only with opt-in; retry state survives repeated imports',async t=>{
 const f=await fixture(t),id=f.created.documentId;
 assert.equal(queueImportedNativeMigration(f.db,id,false),false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM rclone_native_queue').get().n,0);
 assert.equal(queueImportedNativeMigration(f.db,id,true),true);
 f.db.prepare("UPDATE rclone_native_queue SET next_attempt_at=999999,error_code='PROVIDER_CONFLICT'").run();
 assert.equal(queueImportedNativeMigration(f.db,id,true),false);
 assert.equal(f.db.prepare('SELECT next_attempt_at FROM rclone_native_queue').get().next_attempt_at,999999);
});
test('auto migration never queues trashed, disabled or binary sources',async t=>{
 const f=await fixture(t),id=f.created.documentId;
 f.db.prepare('UPDATE resources SET trashed=1 WHERE id=?').run(id);
 assert.equal(queueImportedNativeMigration(f.db,id,true),false);
 f.db.prepare('UPDATE resources SET trashed=0 WHERE id=?').run(id);
 f.db.prepare('UPDATE provider_connections SET enabled=0').run();
 assert.equal(queueImportedNativeMigration(f.db,id,true),false);
 f.db.prepare('UPDATE provider_connections SET enabled=1').run();
 await f.migration.migrate(id,f.client,f.scope);
 assert.equal(queueImportedNativeMigration(f.db,id,true),false);
});
