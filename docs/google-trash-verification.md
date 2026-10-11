# Google Drive trash verification

Verified on the deployed Yourwiki instance on 2026-10-11 using a newly created temporary DOCX in the actual connected Google Drive account.

1. Created a uniquely named document through the regular document service and recorded its Yourwiki ID, provider reference, ACL and content digest.
2. Deleted it through the same service used by the UI/API. Confirmed its active Yourwiki entry disappeared, its durable cloud receipt was confirmed, and Google Drive returned `trashed=true` for the original object.
3. Restored the original using the real Drive API `files.update(trashed=false)`, the operation performed by Drive's restore action.
4. Waited for the running application's background discovery worker. No manual scan or reconciliation call was used.
5. Confirmed the original Yourwiki ID became active again, the provider reference and ACL were unchanged, and downloaded content matched the original digest.
6. Removed only the temporary acceptance document through trash and permanent-delete services. Confirmed no temporary records, pending cloud operations or cloud synchronization errors remained.

This exercises actual OAuth credentials and Google Drive, rather than mocked provider responses. Automated regression coverage lives in `tests/test_cloud_trash.py`; the full backend suite passed with 525 tests, 9 optional tests skipped. Two browser checks verified local Cyrillic fonts on desktop/mobile, and a real CODE browser check verified that Impact is offered by Collabora.

## Repeat manually

Create a temporary document in the Google Drive mount. Delete it in Yourwiki, find its original in the Drive owner's trash, restore it there, and wait for the next background check. Open the same Yourwiki document URL and compare its content and access settings. Finally remove the temporary file through Yourwiki's admin trash. Do not use existing user documents for destructive acceptance tests.
