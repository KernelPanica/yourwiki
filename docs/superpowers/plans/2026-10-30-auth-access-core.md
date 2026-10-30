# SQLite, authentication and access core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Продолжение утверждённой реализации; production Django не переключать.

**Goal:** Надёжная новая SQLite-схема, вход с совместимыми Django password hashes, серверные сессии и локальный ACL с инвалидацией.
**Architecture:** Отдельная новая SQLite, migration ledger с checksum и короткими транзакциями. Репозитории users/resources/memberships, opaque cookie session; ACL вычисляется локально и кешируется по epoch.
**Tech Stack:** Fastify/TypeScript, better-sqlite3, node:crypto, node:test.
**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md.

## Global Constraints

- Не открывать рабочую legacy-базу на запись. На непустой чужой БД новый migrator обязан отказать до изменений.
- Сохранять смысл owner/group/everyone, персональных исключений, write=>read, root defaults и независимого наследования export.
- Session cookie HttpOnly, SameSite=Strict; Secure для HTTPS. Только hash opaque token хранится в БД. Все mutations требуют exact origin + session CSRF token.
- После disable/password change сессия перестаёт работать. Не доверять клиентскому user/group/admin.
- Пароли из Django не менять при импорте. Поддержать default PBKDF2 SHA256/SHA1 и scrypt; недоступные дополнительные алгоритмы явно сообщать в migration preflight, не сбрасывать пароль молча.

## Review Focus

1. Чужая/новее schema не повреждается.
2. Ошибка транзакции не оставляет половину ACL-изменения и не увеличивает epoch.
3. Cached allow не переживает изменение policy/group/account/tree/export.
4. Cross-origin mutation/expired session не выполняется; session plaintext не утекает.
5. Resource с удалённым/циклическим/отсутствующим предком fail closed, даже для admin.

## Task 1: Database

Files: src/database.ts, src/schema.ts, test/database.test.ts.
Interface: openDatabase(path) -> Database; migrate(db); transaction(db, callback) -> value (синхронная callback); SQL named bindings only. App tables: app_state, schema_migrations, users, groups, memberships, resources, sessions, login_attempts. IDs текстовые для lossless импортируемых PK/UUID. users содержит password_hash, active, admin_role, auth_version; sessions привязана к auth_version. resources — kind/id/parent/owner/group/policy/group_policies/user_policies/inherit/export/trashed.
- [x] Тесты persistence/idempotency/FK/rollback/foreign-db refusal/migration checksum/newer version.
- [x] RED, реализовать migrations и репозитории, GREEN.

## Task 2: Password/session

Files: src/auth/passwords.ts, src/auth/sessions.ts, test/passwords.test.ts, test/sessions.test.ts.
Interfaces: verifyPassword(password, encoded)->Promise<boolean>; hashPassword(password)->Promise<string>; createSession(db,userId,now)->{token,csrf,expiresAt}; authenticateSession(db,token,now)->user|null; revokeSession.
- [x] Fixtures генерируются реальными Django hashers, фиксируют совместимость SHA256/SHA1/scrypt; wrong/unusable/malformed hash false; параметры KDF ограничены.
- [x] Проверки expiry/revoke/disabled/auth_version/session hashes/CSRF.
- [x] RED→GREEN, никаких sync KDF на event loop.

## Task 3: ACL/cache

Files: src/access.ts, test/access.test.ts.
Interface: AccessService(db).allows(userId,resourceId,'read'|'write'|'export')->boolean. mutation repositories изменяют epoch атомарно. Runtime cache bounded; raw SQL только migration/tests и внутренний repository.
- [x] Golden cases старой ACL: personal deny > group, inheritance exception, multi-group, root defaults, read/write/admin/export, cycle/trash/missing ancestor.
- [x] Изменения через второе DB connection инвалидируют старый cache; rollback не меняет ACL/epoch.
- [x] RED→GREEN, без remote calls.

## Task 4: HTTP auth

Files: src/auth/routes.ts, src/app.ts, test/auth-routes.test.ts.
Endpoints: POST /api/auth/login, GET /api/account, POST /api/auth/logout. Account sanitised includes groups, admin role, csrf; никогда password_hash/token. Login response sets cookie and csrf; brute-force persisted per account and remote address, no XFF trust.
- [x] Login/invalid credentials/rate limit/cookie expiry/origin CSRF/logout/account sanitisation.
- [x] App database injection opt-in; foundation без database всё ещё not ready и не экспонирует данные.
- [x] Полный npm test/typecheck, offline Python baseline, fresh review и commit.

Этот этап не создаёт UI авторизации и не переносит пользователей автоматически. Importer и React — следующие срезы.

## Выполнение 2026-10-30

- Новый driver better-sqlite3 выбран вместо release-candidate node:sqlite; exact versions в отдельном package-lock.
- Миграции 1–3: schema, auth invalidation, настраиваемые session/login limits.
- Fresh reviewer выявил пропуск foreign sqlite-like table/view в защите migrator; исправлено RED→GREEN и замечание снято.
- Readiness остаётся false без явного local workspace check; наличие auth database не означает готовность файлового workspace.
- Legacy pytest и финальный commit отмечаются в общем журнале после получения результатов.
