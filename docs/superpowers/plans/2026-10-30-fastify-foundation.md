# Fastify foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Утверждение: общий запуск реализации пользователем 2026-10-30. Не менять production entrypoint.

**Goal:** Создать отдельно запускаемый TypeScript backend с корректным health/readiness и безопасным контрактом ошибок.
**Architecture:** Factory без listen side effects, отдельный CLI loopback port 3100, общие ErrorEnvelope. БД, ACL и routes документов добавляются следующими вертикальными задачами; пока backend не объявляет готовность обслуживать данные.
**Tech Stack:** Fastify stable с exact lock, TypeScript, Node >=24.12, node:test/inject.
**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md.

## Global Constraints

Не читать рабочие credentials/БД. Не открывать приложение наружу по умолчанию. Не регистрировать операции файлов до auth/ACL. Не менять корневой package-lock существующих редакторов.

## Review Focus

- Ошибки и URL не раскрывают payload/secrets.
- Request ID генерируется сервером, не доверяется чужому header.
- Liveness не означает готовность БД/миграции.
- Некорректный JSON/слишком большое тело имеют единый понятный контракт.
- Readiness callback failure не превращается в unhandled exception или success.

## Task 1: Контракт сервера

Files: apps/server/package.json, package-lock.json, tsconfig.json, src/app.ts, src/errors.ts, src/main.ts, test/app.test.ts.
Interfaces: buildApp({readiness?: () => Promise<boolean>}) -> FastifyInstance; ErrorEnvelope {code,messageKey,fieldErrors,retryable,operationId,recoveryActions,requestId}.

- [x] Установить exact зависимости в apps/server без изменения старой сборки.
- [x] Написать inject-тесты health, readiness false/true/throw, unknown route, внутренний throw без утечки, malformed JSON и body limit, server-generated requestId.
- [x] Увидеть red до реализации.
- [x] Реализовать app factory/безопасный error handler и separate listen entrypoint, shutdown on SIGINT/SIGTERM.
- [x] Запустить npm test и npm run typecheck в apps/server, затем исходные проверки.
- [x] Описать запуск и ограничения. Отдельный коммит проверенных собственных файлов выполняется после финальных проверок.

Не выдавать factory health за готовый сайт; React/DB/auth ещё не реализованы.
