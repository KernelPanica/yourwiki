# Индекс исходников и проверок Yourwiki

Дата: 2026-10-30. Автоматический структурный индекс; наличие функции или теста не подтверждает корректность выполнения.

## Исходники

- `config/__init__.py` (0 строк)
- `config/asgi.py` (11 строк): `application`
- `config/gunicorn.py` (17 строк): `post_worker_init`
- `config/settings.py` (67 строк)
- `config/test_settings.py` (12 строк)
- `config/urls.py` (97 строк)
- `config/wsgi.py` (4 строк)
- `docker/__init__.py` (0 строк)
- `docker/fetch_drawio.py` (31 строк)
- `docker/install_document_fonts.py` (45 строк): `main`
- `docker/install_google_fonts.py` (132 строк): `install`, `index_catalogue`
- `docker/install_impact.py` (43 строк): `main`
- `docker/start.py` (16 строк)
- `frontend/build.mjs` (20 строк)
- `frontend/canvas-geometry.js` (38 строк)
- `frontend/canvas.js` (59 строк)
- `frontend/diagram-xml.js` (107 строк)
- `frontend/docs-formatting.css` (18 строк)
- `frontend/docs-shell.js` (56 строк)
- `frontend/document-pages.css` (10 строк)
- `frontend/document-pages.js` (83 строк)
- `frontend/document-preview.js` (53 строк)
- `frontend/drawio.js` (33 строк)
- `frontend/editor.js` (106 строк)
- `frontend/google-fonts.js` (23 строк)
- `frontend/page-layout.js` (17 строк)
- `frontend/pdf.js` (237 строк)
- `frontend/presence.js` (55 строк)
- `frontend/rich.js` (153 строк)
- `frontend/shared.js` (61 строк)
- `frontend/sheet-axes.js` (64 строк)
- `frontend/sheet-formulas.js` (73 строк)
- `frontend/sheet-tools.css` (10 строк)
- `frontend/sheet-tools.js` (66 строк)
- `frontend/sheets.js` (86 строк)
- `install.py` (278 строк): `atomic_secret`, `ask`, `authorization_url`, `exchange_code`, `save_google_client_choice`, `authorize`, `storage_config`, `validate_config`, `run`, `main`
- `install_gui.py` (160 строк): `serve`
- `wiki/__init__.py` (0 строк)
- `wiki/access_graph.py` (37 строк): `access_graph`, `attach_documents`, `access_documents`
- `wiki/acl.py` (144 строк): `ResourcePermissionDenied`, `ResourceNotFound`, `normalize_rule`, `normalize_policy`, `validate_rule`, `validate_policy`, `validate_group_policies`, `validate_user_policies`, `apply_api_access`, `settings_context`, `save_settings_access`
- `wiki/administration.py` (58 строк): `SiteForm`, `site_admin`
- `wiki/ai.py` (183 строк): `configuration`, `enabled_providers`, `ProviderForm`, `settings`, `document_text`, `summarize`, `summary`
- `wiki/apps.py` (15 строк): `sqlite_settings`, `WikiConfig`
- `wiki/bundles.py` (103 строк): `export_bundle`, `import_bundle`
- `wiki/cloud_trash.py` (100 строк): `enqueue`, `synchronize`, `untrash_for_restore`, `restore_from_provider`
- `wiki/collabora.py` (431 строк): `eligible`, `check_available`, `origin`, `validate_file`, `editor_action`, `open_session`, `token_for`, `editor`, `wopi`, `read_original`, `editor_bytes`, `wopi_info`, `wopi_contents`, `refresh_office`, `office_status`, `recovery`
- `wiki/collaboration.py` (402 строк): `MarkdownTree`, `xml_node`, `normalize_tree`, `apply_marks`, `xml_json`, `flatten`, `unflatten`, `diagram_data`, `diagram_parse`, `element_data`, `data_element`, `diagram_xml`, `derive`, `seed`, `ensure_room`, `apply_update`, `flush_room`, `current_content`
- `wiki/context.py` (40 строк): `workspace`
- `wiki/crypto.py` (12 строк): `cipher`, `encrypt`, `decrypt`
- `wiki/discovery.py` (29 строк): `scan_sources`, `discover_sources`
- `wiki/docx.py` (260 строк): `_text`, `_paragraph`, `_blocks`, `_table`, `to_native`, `to_docx`
- `wiki/editor_views.py` (214 строк): `live`, `status`, `collaboration_status`, `storage_status`, `metadata`, `reviews`, `resolve_review`, `upload_attachment`, `attachment`, `flush`, `recover`
- `wiki/export_restrictions.py` (41 строк): `sync`
- `wiki/external_sync.py` (64 строк): `refresh`
- `wiki/file_formats.py` (431 строк): `digest`, `valid_container`, `checked_archive`, `metadata`, `embedded`, `read_markdown`, `formula`, `_ods_number_style`, `write_ods`, `read_ods`, `read_docx`, `write_docx`, `encode`, `decode`
- `wiki/file_history.py` (103 строк): `persist`
- `wiki/folders.py` (429 строк): `accessible`, `breadcrumbs`, `target_folder`, `directory_path`, `storage_path`, `validate_directory_name`, `resolve_path`, `create_directory`, `path_depth`, `move_item`, `folder_page`, `move`, `folder_policy`, `deletion_contents`, `deletion_version`, `delete_directory`, `api_folders`, `folder_settings`, `api_folder`
- `wiki/fonts.py` (163 строк): `configuration`, `read_catalogue`, `google_catalogue`, `catalogue`, `font_file`, `activate`, `activate_document_fonts`, `private_font_path`, `private_families`, `private_font_file`
- `wiki/forms.py` (161 строк): `RegistrationForm`, `CreationPermissions`, `DocumentForm`, `DirectoryForm`, `UploadForm`, `InviteForm`, `MemberForm`, `HistoryForm`, `GroupMembershipForm`
- `wiki/graphics.py` (30 строк): `canvas_nodes`
- `wiki/identities.py` (227 строк): `ClientForm`, `clients`, `setup`, `callback_uri`, `endpoints`, `exchange_identity`, `accounts`, `connect`, `callback`, `unlink`, `retry`, `setup_status`
- `wiki/management/__init__.py` (0 строк)
- `wiki/management/commands/__init__.py` (0 строк)
- `wiki/management/commands/backup.py` (17 строк): `Command`
- `wiki/management/commands/convert_file_formats.py` (33 строк): `Command`
- `wiki/management/commands/doctor.py` (63 строк): `Command`
- `wiki/management/commands/scan_storage.py` (112 строк): `Command`
- `wiki/management/commands/sync_provider_grants.py` (10 строк): `Command`
- `wiki/management/commands/sync_storage_tree.py` (30 строк): `Command`
- `wiki/middleware.py` (81 строк): `deny`, `AccessMiddleware`
- `wiki/models.py` (440 строк): `default_policy`, `User`, `Workspace`, `MountPoint`, `SiteConfiguration`, `TrashEntry`, `ProviderTrashState`, `ActiveObjects`, `AccessPolicy`, `Folder`, `Document`, `Collaboration`, `WriteAttempt`, `Review`, `SourceLease`, `Attachment`, `Invitation`, `LoginAttempt`, `PendingDeletion`, `ProviderIdentity`, `ProviderGrant`, `SaveSession`, `OfficeSession`, `OfficeFontActivation`, `ProviderExportRestriction`, `ProviderSyncState`
- `wiki/mounts.py` (280 строк): `MountForm`, `create_mount`, `mountpoints`, `google_callback_uri`, `google_callback`
- `wiki/native.py` (150 строк): `unpack`, `pack`, `validate_native`, `safe_style`, `rich_html`, `plain_text`, `markdown_export`, `csv_export`
- `wiki/office_formats.py` (39 строк): `extension`, `mime`, `presentation`
- `wiki/onboarding.py` (18 строк): `required_providers`
- `wiki/pdf.py` (101 строк): `process_pdf`, `to_native`, `to_pdf`, `_worker`
- `wiki/pdf_layers.py` (99 строк): `layer_state`, `saved_pdf`, `commit_layer`
- `wiki/pdf_models.py` (14 строк): `PdfAnnotationLayer`
- `wiki/presence.py` (128 строк): `_id`, `_selection`, `_entry`, `touch`, `list_active`, `remove`, `expire`
- `wiki/presence_models.py` (16 строк): `PresenceSession`
- `wiki/preview_cache.py` (51 строк): `key`, `content`, `clear`
- `wiki/previews.py` (208 строк): `Cleaner`, `PlainText`, `graph`, `column_label`, `sheet_previews`, `preview`, `image_type`
- `wiki/provider_grants.py` (258 строк): `target`, `sync_lock`, `sync_provider_grants`, `reconcile`, `_sync`, `enqueue_sync`, `synchronize_after_commit`, `process_pending`, `synchronize_background`, `before_save`, `changed`, `membership_changed`, `connect_signals`
- `wiki/provider_sharing.py` (168 строк): `GrantUnavailable`, `managed`, `google_permissions`, `google_managed`, `google_set`, `google_revoke`, `onedrive_permissions`, `ms_recipient`, `onedrive_managed`, `onedrive_set`, `onedrive_revoke`, `github_base`, `github_managed`, `github_set`, `github_revoke`
- `wiki/realtime.py` (208 строк): `authenticate`, `load_state`, `maintenance`, `application`
- `wiki/recovery.py` (27 строк): `decode_snapshot`
- `wiki/saves.py` (107 строк): `write_snapshot`, `stage`, `commit`, `status`
- `wiki/services.py` (194 строк): `storage_key`, `Conflict`, `validate_content`, `group_policies_from_post`, `require`, `save_document`, `redeem_invitation`, `delete_document`, `cleanup_storage`
- `wiki/sheet_batches.py` (306 строк): `_color`, `_style_fields`, `_cells`, `requests_for`, `_sheet_requests`, `_temporary_title`, `_validate_axis`, `_axis_requests`, `_merge_range`
- `wiki/source.py` (37 строк): `valid`, `acquire`, `release`, `check_available`
- `wiki/static/wiki/app.js` (372 строк)
- `wiki/static/wiki/drawio-preview.js` (16 строк)
- `wiki/static/wiki/loading.js` (44 строк)
- `wiki/static/wiki/office-font-focus.js` (48 строк)
- `wiki/static/wiki/office-fonts.js` (78 строк)
- `wiki/static/wiki/office.js` (75 строк)
- `wiki/static/wiki/provider-sync.js` (29 строк)
- `wiki/static/wiki/sheet-preview.js` (56 строк)
- `wiki/static/wiki/storage-watch.js` (18 строк)
- `wiki/static/wiki/theme.js` (28 строк)
- `wiki/static/wiki/ui-errors.js` (97 строк)
- `wiki/static/wiki/versions.js` (24 строк)
- `wiki/static/wiki/workspace-resize.js` (60 строк)
- `wiki/static_headers.py` (10 строк): `add_headers`
- `wiki/storage.py` (1204 строк): `StorageError`, `StorageRejected`, `StorageMissing`, `safe_key`, `file_limit_bytes`, `auxiliary_limit_bytes`, `image_limit_bytes`, `resolve_limit`, `bounded`, `Adapter`, `Local`, `HTTP`, `OAuthHTTP`, `GoogleDrive`, `OneDrive`, `GitHub`, `SFTP`, `SMB`, `SafeAdapter`, `root_mount`, `mount_adapter`, `MountedStorage`, `active_storage`
- `wiki/templates/wiki/access_settings.html` (27 строк)
- `wiki/templates/wiki/account.html` (1 строк)
- `wiki/templates/wiki/ai_settings.html` (5 строк)
- `wiki/templates/wiki/base.html` (74 строк)
- `wiki/templates/wiki/create_menu.html` (8 строк)
- `wiki/templates/wiki/creation_permissions.html` (1 строк)
- `wiki/templates/wiki/delete.html` (1 строк)
- `wiki/templates/wiki/delete_directory.html` (8 строк)
- `wiki/templates/wiki/document.html` (9 строк)
- `wiki/templates/wiki/editor.html` (13 строк)
- `wiki/templates/wiki/error.html` (1 строк)
- `wiki/templates/wiki/explorer_files.html` (1 строк)
- `wiki/templates/wiki/explorer_tree.html` (6 строк)
- `wiki/templates/wiki/favicon.html` (3 строк)
- `wiki/templates/wiki/file.html` (1 строк)
- `wiki/templates/wiki/file_actions.html` (1 строк)
- `wiki/templates/wiki/file_settings.html` (1 строк)
- `wiki/templates/wiki/folders.html` (12 строк)
- `wiki/templates/wiki/google_callback.html` (7 строк)
- `wiki/templates/wiki/graph_node.html` (2 строк)
- `wiki/templates/wiki/group.html` (9 строк)
- `wiki/templates/wiki/groups.html` (7 строк)
- `wiki/templates/wiki/identity_callback.html` (1 строк)
- `wiki/templates/wiki/import.html` (1 строк)
- `wiki/templates/wiki/invitations.html` (1 строк)
- `wiki/templates/wiki/library.html` (6 строк)
- `wiki/templates/wiki/live.html` (36 строк)
- `wiki/templates/wiki/login.html` (1 строк)
- `wiki/templates/wiki/member.html` (5 строк)
- `wiki/templates/wiki/members.html` (5 строк)
- `wiki/templates/wiki/mounts.html` (9 строк)
- `wiki/templates/wiki/move.html` (1 строк)
- `wiki/templates/wiki/new_directory.html` (1 строк)
- `wiki/templates/wiki/office.html` (33 строк)
- `wiki/templates/wiki/office_embed.html` (1 строк)
- `wiki/templates/wiki/pdf.html` (30 строк)
- `wiki/templates/wiki/permissions.html` (1 строк)
- `wiki/templates/wiki/policy.html` (1 строк)
- `wiki/templates/wiki/provider_accounts.html` (13 строк)
- `wiki/templates/wiki/provider_grants.html` (1 строк)
- `wiki/templates/wiki/provider_setup.html` (17 строк)
- `wiki/templates/wiki/public.html` (1 строк)
- `wiki/templates/wiki/register.html` (1 строк)
- `wiki/templates/wiki/row_actions.html` (5 строк)
- `wiki/templates/wiki/settings_navigation.html` (13 строк)
- `wiki/templates/wiki/sheet_preview.html` (17 строк)
- `wiki/templates/wiki/site_admin.html` (6 строк)
- `wiki/templates/wiki/summary.html` (7 строк)
- `wiki/templates/wiki/trash.html` (8 строк)
- `wiki/templates/wiki/trash_item.html` (3 строк)
- `wiki/templates/wiki/upload.html` (1 строк)
- `wiki/templates/wiki/version_panel.html` (1 строк)
- `wiki/templates/wiki/version_preview.html` (13 строк)
- `wiki/templates/wiki/workspace_resizer.html` (1 строк)
- `wiki/templatetags/__init__.py` (0 строк)
- `wiki/templatetags/wiki_ui.py` (36 строк): `icon`
- `wiki/trash.py` (265 строк): `administrator`, `subtree`, `ensure_no_trashed_descendants`, `retire_editors`, `trash_document`, `trash_directory`, `restore`, `purge`, `index`, `manage`, `trash_user`, `trash_group`, `restore_record`, `purge_record`, `active_groups`, `trash_invitation`
- `wiki/version_views.py` (155 строк): `entries`, `snapshot`, `version_name`, `versions`, `download`, `preview`, `restore`
- `wiki/views.py` (784 строк): `denied`, `csrf_failure`, `set_language`, `guarded`, `failure`, `visible_docs`, `document_for`, `health`, `sign_in`, `sign_out`, `library`, `file_details`, `detail`, `editor`, `save_office_upload`, `upload_file`, `import_document`, `export_document`, `star`, `remove`, `policy`, `permissions`, `invitations`, `revoke`, `redeem`, `members`, `groups`, `group_detail`, `member`, `account`, `serialized`, `api_documents`, `api_document`, `save_pdf`, `file_settings`, `file_history`, `api_file_content`
- `wiki/write_journal.py` (254 строк): `WriteUncertain`, `_directory`, `_atomic`, `_save`, `_load`, `_remove`, `_index`, `_equivalent`, `recover`, `perform`, `discard`, `acknowledge`, `prepare_move`, `recover_moves`

## Именованные Python-проверки

### tests/browser/test_account_loading_and_deletion.py

- `test_account_link_shows_progress_and_recovers_after_failure`
- `test_recursive_deletion_confirmation_and_mobile_layout`

### tests/browser/test_admin_roles_presentations.py

- `test_embedded_slides_and_simple_admin_trash`

### tests/browser/test_autosave_ui.py

- `test_autosave_and_conflict_copy`
- `test_pdf_download_keeps_edits_after_write_revocation`

### tests/browser/test_browser.py

- `test_workspace_and_registration`
- `test_diagrams_and_table`
- `test_explorer_and_workspace_menu`
- `test_drag_and_path_creation`
- `test_mountpoint_interface`
- `test_russian_language`
- `test_docx_creation_and_history_settings`

### tests/browser/test_collabora_editor.py

- `test_real_docx_edit_and_save`
- `test_real_additional_office_formats_load`
- `test_real_collabora_shared_cursor_and_readonly`
- `test_real_collabora_offers_open_fonts`

### tests/browser/test_create_format.py

- `test_creation_format_changes_without_navigation`

### tests/browser/test_creation_acl_ui.py

- `test_creation_permissions_controls`

### tests/browser/test_document_pages.py

- `test_document_pages_preserve_long_paragraph_and_reflow`

### tests/browser/test_editor_themes.py

- `test_editor_dark_theme_surfaces`
- `test_embedded_editor_dark_theme`

### tests/browser/test_external_sync_ui.py

- `test_remote_edit_updates_open_document_and_pdf`
- `test_leaving_dirty_editor_does_not_force_save`
- `test_remote_conflict_warns_and_copies_local_edits`
- `test_office_remote_conflict_never_reloads_unsignalled_edits`
- `test_new_remote_files_are_discovered_without_manual_command`

### tests/browser/test_folder_settings_navigation.py

- `test_folder_and_root_settings_visible_on_desktop_and_mobile`

### tests/browser/test_google_oauth.py

- `test_google_return_with_strict_session_cookie`

### tests/browser/test_graphics_roundtrip_ui.py

- `test_diagram_browser_and_server_preserve_xml_envelopes`
- `test_graph_presence_selection_and_disconnect`
- `test_two_canvas_drags_add_and_pointer_cancel_recovers`

### tests/browser/test_layout_spacing.py

- `test_responsive_spacing`

### tests/browser/test_loading_ui.py

- `test_loading_parallel_error_background_and_themes`

### tests/browser/test_office_document_controls.py

- `test_document_fonts_headings_spacing_and_mobile`

### tests/browser/test_office_font_focus.py

- `test_font_commit_returns_input_but_search_and_readonly_keep_focus`

### tests/browser/test_office_lazy_fonts.py

- `test_add_font_is_inside_code_lazy_and_preserves_document`

### tests/browser/test_office_sheet_controls.py

- `test_russian_formulas_calculate_and_save`

### tests/browser/test_pdf.py

- `test_pdf_annotations_and_forms`
- `test_table_controls_and_simplified_pages`

### tests/browser/test_pdf_workspace.py

- `test_pdf_viewport_zoom_pan_and_explorer`

### tests/browser/test_performance_onboarding.py

- `test_pending_cloud_access_shows_progress_then_finishes`

### tests/browser/test_personal_access_fonts_ui.py

- `test_personal_permissions_form_and_full_font_menu`

### tests/browser/test_presence_ui.py

- `test_text_presence_readonly_selection_disconnect`
- `test_unknown_write_pauses_autosave_and_allows_manual_retry`

### tests/browser/test_preview_document_fonts.py

- `test_preview_loads_used_font_and_reflows_pages`

### tests/browser/test_provider_accounts.py

- `test_provider_account_settings_layout`

### tests/browser/test_provider_setup_ui.py

- `test_registration_required_setup_and_provider_return`

### tests/browser/test_rw_settings.py

- `test_simple_creation_and_rw_settings`

### tests/browser/test_saved_graphs.py

- `test_saved_canvas_and_drawio_display`

### tests/browser/test_sheet_presence.py

- `test_table_presence_uses_stable_cell_ids_and_clears_on_disconnect`

### tests/browser/test_sheet_preview_ui.py

- `test_saved_worksheets_have_coordinates_and_keyboard_tabs`

### tests/browser/test_sheet_tabs_ui.py

- `test_visual_editor_adds_renames_reorders_and_deletes_persisted_worksheets`

### tests/browser/test_sleek_theme.py

- `test_theme_contrast_and_persistence`

### tests/browser/test_trash_and_fonts.py

- `test_trash_restore_and_local_fonts`

### tests/browser/test_ui_error_actions.py

- `test_upload_error_retains_file_and_allows_retry`
- `test_network_and_unexpected_action_errors_are_visible`

### tests/browser/test_version_restore_ui.py

- `test_versions_preview_and_restore_on_mobile`

### tests/browser/test_visual.py

- `test_rich_collaboration`
- `test_visual_editor_loads`
- `test_localized_canvas_preview`
- `test_image_view_and_delete`
- `test_sheet_row_delete_undo_preserves_identity`

### tests/browser/test_word_editor.py

- `test_word_gui_edits_merges_and_exports`

### tests/browser/test_workspace_resize.py

- `test_sidebar_and_resizable_office_pdf`
- `test_presentation_has_more_vertical_space`
- `test_office_external_update_reload_or_preserve_edits`

### tests/browser/test_workspace_ui.py

- `test_workspace_redesign`

### tests/test_access.py

- `test_all_anonymous_protected_routes_return_500`
- `test_login_and_persistent_session`
- `test_login_throttle`
- `test_reader_and_hidden_documents`
- `test_rw_implication_and_scope_precedence`
- `test_csrf_failure_500`
- `test_public_routes_and_nonexistent_resources`
- `test_disabled_session_is_denied`

### tests/test_admin_roles_export.py

- `test_simple_admin_restores_but_cannot_purge_or_escalate`
- `test_giga_assigns_simple_role_and_user_trash_roundtrip`
- `test_group_trash_preserves_identity_files_and_memberships`
- `test_export_restriction_inheritance_routes_and_ui`
- `test_collabora_export_flags_and_readonly_preview_token`
- `test_archived_accounts_and_groups_cannot_bypass_trash`
- `test_google_export_sync_confirms_and_restores_original`
- `test_presentation_embedded_view_is_readonly`
- `test_invitation_trash_roundtrip_and_purge_role`

### tests/test_admin_ui.py

- `test_header_cleanup_and_admin_only_settings`
- `test_administration_persists_and_applies_settings`
- `test_nested_directory_navigation_hides_private_names`
- `test_explorer_files_and_menu_respect_permissions`

### tests/test_bundles_source.py

- `test_bundle_preserves_content_reviews_and_state`
- `test_bundle_rewrites_image_references`
- `test_bundle_cannot_extract_arbitrary_paths`
- `test_exclusive_source_replaces_room_without_lost_live_edits`
- `test_source_cancel_releases_lock`

### tests/test_cloud_trash.py

- `test_google_deletion_and_external_restore_preserve_identity`
- `test_restore_in_yourwiki_untrashes_google`
- `test_network_failure_is_durable_and_not_mistaken_for_restore`
- `test_uncertain_remote_success_is_reconciled`
- `test_restore_one_remote_file_from_trashed_tree`
- `test_google_adapter_uses_trash_patch_not_delete`

### tests/test_collabora.py

- `test_shared_sessions_and_exact_binary_save`
- `test_tokens_are_bound_expired_and_revoked`
- `test_readonly_token_and_revoked_write_cannot_save`
- `test_lock_mismatch_and_refresh`
- `test_external_conflict_keeps_recovery_and_original`
- `test_other_editors_are_blocked_and_old_sessions_rotate`
- `test_discovery_ui_has_no_provider_secrets`
- `test_storage_failure_retains_bytes_for_retry`
- `test_invalid_upload_and_ods_binary_save`
- `test_legacy_docx_relationships_are_repaired_without_storage_write`
- `test_expired_failed_session_reopens_with_recovery`
- `test_create_presentation_and_save_complete_pptx`
- `test_uploaded_office_files_remain_exact_and_open_in_collabora`
- `test_markdown_engine_save_and_binary_format_rejection`
- `test_office_heartbeat_rotates_external_version_and_keeps_late_edits`
- `test_office_status_does_not_expose_another_authors_recovery`
- `test_collabora_docx_logical_alignment_reopens_and_permissions_remain_editable`
- `test_trash_revokes_wopi_and_old_session_cannot_write_after_restore`

### tests/test_collaboration.py

- `test_concurrent_text_merges_and_retry_is_idempotent`
- `test_two_writers_merge_and_save_without_history`
- `test_storage_failure_does_not_lose_acknowledged_edits`
- `test_reader_cannot_send_collaborative_updates`
- `test_legacy_save_cannot_overwrite_collaboration`
- `test_graph_and_table_roundtrip`
- `test_reviews_require_read_and_resolution_requires_write`
- `test_image_upload_is_sanitized_and_protected`
- `test_native_preview_cannot_inject_script`

### tests/test_concurrency.py

- `test_single_use_invite_is_atomic`
- `test_two_file_saves_cannot_overwrite_each_other`

### tests/test_creation_permissions.py

- `test_creation_has_no_acl_matrix`
- `test_creation_inherits_and_ignores_legacy_acl_injection`
- `test_folder_and_upload_inherit`
- `test_multiple_group_rules_settings_reload_and_move`
- `test_explicit_group_deny_is_inherited`
- `test_new_document_defaults_to_docx`
- `test_creation_applies_selected_extension`

### tests/test_docs_gui_upgrade.py

- `test_docs_gui_upgrade_word_run_and_paragraph_roundtrip`
- `test_docs_gui_upgrade_legacy_px_size_and_hard_break`
- `test_docs_gui_upgrade_list_indentation_and_table_merge_roundtrip`
- `test_docs_gui_upgrade_preview_safe_fonts_spacing_and_cell_fill`
- `test_docs_gui_upgrade_word_table_header_column`

### tests/test_documents.py

- `test_api_defaults_to_docx`
- `test_create_read_edit_export`
- `test_conflicting_save_does_not_overwrite`
- `test_failed_storage_preserves_editor_content`
- `test_pages_render`
- `test_preview_kinds`
- `test_import_and_limit`
- `test_docx_import_is_editable`
- `test_docx_upload_is_persistent_editable_document`
- `test_delete_and_star`
- `test_bad_api_input_and_policy`
- `test_api_delete_and_retry_queue`
- `test_mixed_api_updates_are_rejected_without_changes`

### tests/test_editor_fonts.py

- `test_collabora_font_catalogue_is_public_and_assets_are_real`
- `test_every_bundled_font_contains_complete_russian_alphabet`
- `test_installed_google_catalogue_serves_only_registered_open_fonts`
- `test_google_font_catalogue_has_every_declared_upstream_font`
- `test_activation_requires_document_write_access`
- `test_existing_document_activates_only_used_known_families`
- `test_default_original_fonts_are_authenticated_and_never_public`
- `test_preview_retains_google_fonts_and_rejects_css_injection`
- `test_preview_imports_inherited_word_font`

### tests/test_external_sync.py

- `test_external_change_replaces_clean_room_and_rejects_old_generation`
- `test_external_change_preserves_pending_local_edits`
- `test_provider_failure_leaves_room_unchanged`
- `test_storage_heartbeat_enforces_read_access`
- `test_portable_external_files_refresh_editor_state`
- `test_unknown_write_is_not_replaced_by_remote_scan`
- `test_http_flush_checks_generation_and_returns_save_confirmation`

### tests/test_file_preview.py

- `test_image_preview_and_download`
- `test_unverified_files_are_download_only`
- `test_delete_buttons_and_server_permissions`

### tests/test_folder_settings_navigation.py

- `test_root_has_visible_permission_settings_link`
- `test_folder_settings_are_in_heading_and_child_actions`
- `test_non_admin_cannot_change_root_permissions`

### tests/test_folders.py

- `test_inheritance_and_private_ancestor_override`
- `test_move_requires_both_containers_and_prevents_cycles`
- `test_nonempty_folder_cannot_be_deleted`
- `test_hidden_ancestor_is_not_serialized`
- `test_path_creation_empty_files_and_uploads`
- `test_drag_move_endpoint_checks_cycles_and_permissions`
- `test_provider_tree_tracks_nested_files_moves_and_legacy_revisions`
- `test_renaming_a_live_document_preserves_path_and_moves_revision`
- `test_shared_directory_under_private_parent_accepts_uploads_without_leaking_path`

### tests/test_global_history.py

- `test_global_history_ignores_every_legacy_override`
- `test_default_off_and_disabling_preserves_existing_history`
- `test_resource_settings_cannot_mutate_legacy_history_flags`
- `test_mount_form_has_no_history_control_and_ignores_legacy_input`
- `test_mount_credential_edit_preserves_legacy_override`
- `test_administrator_can_toggle_global_history_and_member_cannot`

### tests/test_google_mount_oauth.py

- `test_connect_google_gets_token_and_keeps_secrets_server_side`
- `test_google_flow_rejects_state_session_expiry_and_csrf`
- `test_failed_google_auth_does_not_create_mount`
- `test_google_creation_and_admin_revocation`
- `test_saved_client_requires_explicit_selection`
- `test_reconnect_existing_root_requests_full_drive_access`
- `test_reconnect_updates_same_root_and_keeps_existing_objects`

### tests/test_google_native_files.py

- `test_native_sheet_id_url_history_and_external_conflict`
- `test_private_account_required_without_rewriting_provider_acl`
- `test_native_google_scan_and_restart_restore_without_snapshot`
- `test_google_native_cross_mount_move_keeps_identity`
- `test_large_google_history_uses_resumable_upload`
- `test_cell_edit_uses_native_batch_and_keeps_id`
- `test_batch_failure_never_falls_back_to_import`
- `test_renaming_native_table_still_uses_batch_without_import`
- `test_batch_rejects_change_after_original_fingerprint`
- `test_collaborative_structure_baseline_advances_only_after_provider_save`
- `test_sheet_topology_is_one_native_batch_with_stable_provider_ids`
- `test_collabora_google_sheet_opens_and_saves_same_original`
- `test_collabora_uncertain_google_import_keeps_recovery_without_second_import`
- `test_office_import_rechecks_native_version_before_dispatch`

### tests/test_graphics_roundtrip.py

- `test_diagram_envelope_namespaces_and_mixed_content_roundtrip`
- `test_diagram_deleted_cell_is_not_restored_by_envelope`
- `test_concurrent_canvas_movements_add_and_replay_is_idempotent`

### tests/test_group_membership.py

- `test_member_list_has_no_group_creation_and_login_opens_files`
- `test_group_membership_changes_only_on_group_page`
- `test_group_membership_requires_admin_and_valid_selection`
- `test_group_with_folder_cannot_be_deleted`

### tests/test_install.py

- `test_fresh_setup_rerun_and_reconnect`
- `test_failed_probe_does_not_create_admin_and_can_resume`
- `test_backup_roundtrip`
- `test_doctor_reports_health_without_secrets`
- `test_install_rejects_http_by_default`
- `test_google_setup_optional_reusable_client`
- `test_google_setup_prompt_defaults_to_yes`

### tests/test_install_gui.py

- `test_browser_installer_private_setup_and_completion`
- `test_browser_installer_layout_and_success`

### tests/test_invitations.py

- `test_create_and_redeem_once`
- `test_member_invite_delegation_and_group_restrictions`
- `test_expired_revoked_and_exhausted_are_identical`
- `test_removed_inviter_permission_invalidates_link`
- `test_reusable_link`
- `test_admin_member_controls`

### tests/test_language.py

- `test_russian_workspace_and_english_fallback`
- `test_spanish_workspace_and_editor_catalog`
- `test_spanish_catalog_covers_workspace_strings`
- `test_graph_preview_uses_unlocalized_geometry`
- `test_language_switch_sets_cookie_and_redirects`

### tests/test_live_storage.py

- `test_live_provider`

### tests/test_mounts.py

- `test_upgrade_adopts_existing_storage_as_root`
- `test_root_and_longest_mount_routing_preserve_existing_references`
- `test_cross_mount_moves_relocate_attachments_and_empty_subdirectories`
- `test_failed_move_preserves_original_file`
- `test_keyboard_move_form_supports_files_and_directories`
- `test_mount_admin_creation_reconnect_and_unmount`
- `test_mount_boundaries_cannot_hide_files_or_move_with_parent`
- `test_mount_path_is_not_disclosed_through_shared_child`
- `test_folder_grants_support_multiple_groups`

### tests/test_nginx_upload.py

- `test_production_proxy_upload_limits`

### tests/test_ods_styles.py

- `test_standard_ods_extended_styles_do_not_depend_on_metadata`
- `test_standard_ods_number_formats_roundtrip`
- `test_strict_ods_rejects_unrepresentable_formatting`
- `test_local_writer_rejects_unsupported_format_before_mutating_file`
- `test_standard_datetime_uses_month_and_minute_elements`

### tests/test_office_number_formats.py

- `test_quick_number_formats_survive_ods`

### tests/test_pdf_ai.py

- `test_pdf_upload_view_fill_and_conflict`
- `test_pdf_validation_and_scans`
- `test_summary_provider_payloads`
- `test_ai_settings_encryption_and_pdf_summary`

### tests/test_pdf_layers.py

- `test_pdf_annotations_save_separately_and_reopen`
- `test_pdf_layer_external_change_conflicts_and_retains_pending`
- `test_pdf_layer_fails_without_damaging_base_and_retries`
- `test_pdf_stale_layer_is_not_applied_to_new_base`
- `test_pdf_layer_checks_revoked_access_before_provider_write`
- `test_pdf_layer_rechecks_base_after_provider_write`
- `test_pdf_corrupt_annotation_artifact_does_not_hide_original`

### tests/test_performance_pipeline.py

- `test_oauth_refresh_is_reused_and_rotated_token_is_saved`
- `test_concurrent_oauth_requests_share_refresh`
- `test_failed_oauth_refresh_retries_and_short_lived_token_is_not_extended`
- `test_permission_action_enqueues_without_network`
- `test_permission_worker_preserves_new_requests_and_retries`
- `test_preview_cache_avoids_remote_reads_but_not_pending_edits`
- `test_preview_cache_single_flight_expiry_and_error_retry`
- `test_native_and_office_open_read_without_write_transaction`
- `test_only_content_hashed_assets_are_cached_immutably`
- `test_reopening_unchanged_native_editor_does_not_rebuild_crdt`
- `test_forced_reconciliation_stays_durable`
- `test_cached_preview_does_not_cache_permissions`
- `test_uploaded_office_preview_does_not_download_for_image_detection`

### tests/test_personal_access.py

- `test_individual_write_implies_read_and_deny_overrides_group`
- `test_folder_rules_are_inherited_and_local_override_applies`
- `test_api_personal_grants_validate_and_are_admin_only`
- `test_settings_save_user_rules`
- `test_local_personal_access_keeps_parent_inheritance`

### tests/test_portable_files.py

- `test_global_history_stale_save_and_physical_rename`
- `test_portable_files_restore_editor_without_database_state`
- `test_ods_formula_styles_sheets_and_foreign_import`
- `test_external_conflict_and_explicit_reload`
- `test_recursive_acl_owner_and_group_overrides`
- `test_original_link_read_permissions_and_provider_move`
- `test_history_settings_require_write`
- `test_failed_first_history_save_is_retryable`
- `test_history_can_hold_a_full_size_file`
- `test_legacy_conversion_preserves_native_content_and_is_repeatable`
- `test_scan_does_not_publish_history_as_an_independent_file`
- `test_text_document_cannot_claim_a_spreadsheet_format`
- `test_legacy_source_read_establishes_external_conflict_baseline`
- `test_stale_room_document_uses_moved_file`
- `test_document_policy_exposes_and_preserves_inheritance`
- `test_failed_save_restores_existing_history_and_rename`
- `test_formats_must_match_the_file_kind`
- `test_creation_form_applies_text_format_only_to_documents`

### tests/test_presence.py

- `test_presence_readonly_heartbeat_reconnect_and_expiry`
- `test_presence_binds_id_to_user_and_document`
- `test_presence_keeps_tabs_distinct_and_filters_revoked_users`
- `test_presence_rejects_invalid_or_oversized_payload`
- `test_presence_stable_table_graph_and_pointer_refs`
- `test_presence_rejects_invalid_session_identifier`

### tests/test_presence_transport.py

- `test_readonly_presence_broadcast_and_disconnect`
- `test_invalid_presence_does_not_change_crdt`
- `test_disconnect_does_not_retry_unknown_write`

### tests/test_previews.py

- `test_markdown_escapes_html_and_removes_unsafe_links`
- `test_compressed_drawio`
- `test_bad_geometry_and_xml_entities`
- `test_drawio_grouped_wrapped_cells_preview_after_saved_roundtrip`
- `test_canvas_preview_preserves_custom_color_and_multiline_text`
- `test_canvas_group_background_is_behind_saved_cards`
- `test_canvas_preview_obeys_obsidian_edge_sides_and_ends`

### tests/test_provider_grants.py

- `test_grant_read_write_and_revoke`
- `test_failure_preserves_acl_and_retries`
- `test_missing_identity_pending_and_unlink_revokes`
- `test_deleted_document_revoke`
- `test_identity_change_revokes_old_before_new`
- `test_failed_revoke_retains_receipt_and_retry`
- `test_github_never_grants_repository_access_for_file_acl`
- `test_acl_commits_trigger_sync`
- `test_all_deleted_user_receipts_are_retried`
- `test_onedrive_same_item_across_roots_uses_drive_identity`
- `test_onedrive_missing_namespace_is_resolved`
- `test_content_metadata_does_not_resync_all_grants`
- `test_account_grants_do_not_reveal_unreadable_files`
- `test_autosave_unchanged_reference_does_not_reconcile_grants`
- `test_github_existing_grants_revoke_durably_and_retry`
- `test_github_grant_ui_explains_unsupported_file_grants`
- `test_trash_revokes_and_restore_reinstates_provider_rights`
- `test_personal_rule_updates_google_grant_and_revokes`

### tests/test_provider_identity.py

- `test_link_requires_matching_one_time_state`
- `test_get_callback_never_links`
- `test_oauth_client_config_admin_only`
- `test_identity_cannot_be_claimed_by_two_users`
- `test_expired_oauth_state_is_consumed`
- `test_google_identity_rejects_unverified_email`

### tests/test_provider_onboarding.py

- `test_registration_redirects_to_persistent_required_setup`
- `test_local_setup_explains_no_oauth_and_finishes`
- `test_cloud_setup_cannot_be_skipped_or_completed_without_identity`
- `test_oauth_returns_to_required_setup_and_successful_grants_unlock`
- `test_failed_grant_keeps_setup_required`
- `test_existing_admin_can_configure_oauth_during_setup`
- `test_setup_applies_actual_rw_grants_before_unlocking`
- `test_unfinished_setup_blocks_websocket_authentication`
- `test_every_accessible_cloud_provider_is_required`
- `test_cloud_setup_waits_without_blocking_request`

### tests/test_provider_sharing.py

- `test_google_inherited_permission_is_not_reported_as_synced`
- `test_google_never_demotes_or_revokes_owner`
- `test_google_personal_create_update_revoke`
- `test_onedrive_invite_requires_signin_and_revoke`
- `test_google_public_and_untracked_permissions_stay_blocked`
- `test_github_does_not_upgrade_read_to_write`
- `test_github_write_and_invitation_revocation`
- `test_onedrive_recovers_lost_invite_among_other_named_users`

### tests/test_requested_ui_features.py

- `test_summary_visibility`
- `test_recursive_deletion_confirmation_and_storage`
- `test_recursive_delete_denied_child_leaves_everything`
- `test_recursive_delete_remote_failure_is_retryable`
- `test_stale_deletion_confirmation_does_not_delete_new_file`
- `test_pending_deletion_scan_does_not_recreate_folder`

### tests/test_rw_permissions.py

- `test_write_implies_read_and_no_visibility_flag`
- `test_unreadable_is_missing_in_lists_and_direct_urls`
- `test_safe_legacy_conversion`
- `test_root_defaults_are_inherited`
- `test_creation_is_simple_and_inherits_group`
- `test_api_create_in_folder_and_admin_only_acl`
- `test_provider_binary_rw_contract`
- `test_migration_preserves_hidden_and_explicit_acl`
- `test_settings_rw_server_validation_and_redirect`
- `test_folder_api_and_revocation`
- `test_readonly_websocket_cannot_force_provider_write`
- `test_scanned_files_inherit_workspace_and_parent`
- `test_invalid_acl_api_is_atomic`

### tests/test_save_sessions.py

- `test_collaborative_conflict_is_durable_and_never_retried`
- `test_pending_save_rechecks_writer_access`
- `test_provider_failure_keeps_payload_and_can_retry`
- `test_http_flush_and_explicit_recovery`
- `test_pdf_stale_sessions_do_not_overwrite_and_retry_is_idempotent`
- `test_pdf_open_records_legacy_baseline_and_detects_external_change`
- `test_pdf_retry_does_not_acknowledge_another_tabs_revision`
- `test_offline_snapshot_round_trip`
- `test_legacy_room_is_written_as_markdown_not_json`

### tests/test_sheet_batches.py

- `test_sparse_values_formulas_and_clears_preserve_untouched_cells`
- `test_style_mask_does_not_clear_remote_number_format_or_notes`
- `test_untracked_topology_changes_fail_before_any_mutation`
- `test_styled_blank_cells_survive_provider_export_without_metadata`
- `test_grid_resize_is_not_reported_as_successful_empty_batch`
- `test_native_insert_and_delete_remap_existing_cells_without_rewriting_them`
- `test_reordering_rows_moves_provider_metadata_instead_of_replacing_values`
- `test_untrusted_or_missing_axis_baseline_cannot_guess_structure`
- `test_missing_baseline_also_rejects_same_size_identity_changes`
- `test_insert_with_changed_merge_stays_native`
- `test_grid_dimensions_survive_export_without_yourwiki_metadata`
- `test_structural_edit_does_not_unmerge_provider_tail`
- `test_native_sheet_identity_survives_rename_add_delete_and_reorder`
- `test_native_extended_formats_and_precise_removal`
- `test_unsupported_style_changes_fail_but_unchanged_provider_extras_survive`
- `test_border_styles_follow_installed_univer_enum`
- `test_supported_format_default_reset_is_precise`
- `test_wrap_strategy_matches_univer`
- `test_tracked_sheets_do_not_fall_back_to_title_if_identity_disappears`
- `test_unrepresentable_border_changes_are_explicitly_rejected`
- `test_nested_unsupported_color_changes_are_not_silently_ignored`

### tests/test_sheet_preview.py

- `test_sheet_preview_keeps_order_dimensions_and_blank_cells`
- `test_csv_preview_has_coordinates_and_ragged_rows_are_padded`
- `test_sheet_preview_resolves_stable_axes_in_display_order`
- `test_large_sheet_preview_is_bounded_without_losing_dimension_counts`
- `test_sheet_preview_shows_uncached_formulas_and_keeps_zero_values`

### tests/test_storage.py

- `test_cloud_crud_contract`
- `test_network_filesystem_contract`
- `test_local_storage_and_traversal`
- `test_remote_directory_paths_use_provider_folders`
- `test_http_errors_do_not_leak_provider_details`
- `test_onedrive_refuses_unverified_or_shared_items`
- `test_github_refuses_public_or_shared_repositories`
- `test_cross_filesystem_move_keeps_original_without_copy`

### tests/test_storage_discovery.py

- `test_all_files_and_empty_directories_are_indexed`
- `test_all_mounts_are_scanned_without_shadowing`
- `test_unreadable_content_is_still_catalogued`
- `test_service_history_hidden_files_and_symlinks`
- `test_remote_adapter_recursive_listing`

### tests/test_trash.py

- `test_file_trash_preserves_original_and_denies_every_entrypoint`
- `test_bin_admin_only_get_post_and_navigation`
- `test_recursive_restore_retains_prior_separate_trash`
- `test_purge_includes_previous_trash_and_storage_retry`
- `test_attachment_and_history_retained_then_purged`
- `test_mount_cannot_hide_trashed_sources_and_group_delete_has_clear_error`
- `test_trashed_ancestor_also_denies_unmarked_children`

### tests/test_ui_errors.py

- `test_missing_item_error_is_json_on_ui_route`
- `test_unexpected_upload_failure_keeps_safe_contract`
- `test_upload_field_errors_are_structured`
- `test_csrf_failure_explains_how_to_recover`
- `test_unguarded_view_exception_has_safe_response`

### tests/test_upload_configuration.py

- `test_admin_accepts_arbitrary_upload_limit`
- `test_large_file_round_trip_and_validation`
- `test_upload_uses_configured_limit`
- `test_large_office_and_pdf_validation`
- `test_admin_form_saves_unlimited_and_shows_help`

### tests/test_version_restore.py

- `test_version_list_preview_download_and_restore_preserves_bytes_and_identity`
- `test_restore_rejects_stale_revision_and_external_change`
- `test_restore_rejects_corrupted_snapshot`
- `test_read_only_user_can_view_but_cannot_restore`
- `test_versions_available_when_history_disabled`
- `test_restoration_is_post_only_and_exclusive_source_blocks`
- `test_pdf_version_inline_is_allowed_in_same_origin_preview`
- `test_uploaded_docx_file_version_has_visual_preview`
- `test_canvas_version_download_retains_obsidian_extension`

### tests/test_workspace_performance.py

- `test_workspace_queries_do_not_grow_with_tree`
- `test_personal_deny_and_trashed_parent_still_hidden`
- `test_acl_update_is_visible_without_cache_expiry`
- `test_folder_page_queries_stay_bounded`
- `test_ajax_redirect_does_not_render_destination`
- `test_library_and_context_share_graph_within_request`
- `test_reconciliation_acl_query_count_does_not_grow_per_user_file`

### tests/test_write_recovery.py

- `test_lost_provider_ack_is_reconciled_without_second_write`
- `test_unknown_outcome_never_replays_over_an_external_edit`
- `test_newer_edits_after_lost_ack_are_written_against_confirmed_base`
- `test_unknown_write_keeps_created_history_for_reconciliation`
- `test_lost_rename_response_restores_path_identity`
- `test_rename_only_sql_rollback_keeps_recovery_reference`
- `test_failed_rename_never_binds_to_identical_unrelated_target`
- `test_creation_reference_survives_fingerprint_failure`
