-- DealMind AI — least-privilege database roles (Phase 7.1).
--
-- Run as the database OWNER (the role that runs Prisma migrations), after
-- migrations, with psql variables:
--
--   psql -v ON_ERROR_STOP=1 -v app_password="$DEALMIND_APP_DB_PASSWORD" \
--        -v agent_password="$DEALMIND_AGENT_DB_PASSWORD" -d dealmind -f roles.sql
--
-- Roles:
--   <owner>          migrations only (DDL). Never used by running services.
--   dealmind_app     API + worker: read/write rows in `public`, no DDL, no
--                    superuser, no role/database creation, no COPY PROGRAM.
--   dealmind_agent   Python agent: SELECT on the two read-model tables it uses,
--                    plus its own LangGraph checkpoint schema.
--
-- Idempotent: safe to re-run after each deployment (new tables are covered by
-- the default privileges below; re-running also re-applies grants).
-- Single platform: no tenant roles, no per-tenant schemas.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE dealmind_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealmind_app') \gexec
SELECT format('ALTER ROLE dealmind_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L', :'app_password') \gexec

SELECT format('CREATE ROLE dealmind_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L', :'agent_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealmind_agent') \gexec
SELECT format('ALTER ROLE dealmind_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L', :'agent_password') \gexec

-- Nobody but the owner creates objects in `public`.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO dealmind_app, dealmind_agent', current_database()) \gexec

-- API + worker: DML on every table and sequence, now and in future migrations.
GRANT USAGE ON SCHEMA public TO dealmind_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dealmind_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO dealmind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dealmind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO dealmind_app;
-- Prisma's migration bookkeeping is the owner's business only.
REVOKE ALL ON TABLE public."_prisma_migrations" FROM dealmind_app;

-- Agent: read models only (apps/agent/app/database/read_models.py).
GRANT USAGE ON SCHEMA public TO dealmind_agent;
GRANT SELECT ON TABLE public."AgentRun", public."Search" TO dealmind_agent;

-- Agent: its own checkpoint schema (LangGraph creates and migrates its tables there).
CREATE SCHEMA IF NOT EXISTS agent_checkpoints AUTHORIZATION dealmind_agent;
