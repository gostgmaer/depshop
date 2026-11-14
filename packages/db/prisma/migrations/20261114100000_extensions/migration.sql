-- Trigram similarity: fuzzy product-title matching and search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pgvector: embeddings for semantic product matching. Installed only when the
-- server provides it, so this migration also succeeds on plain PostgreSQL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector not available on this server; skipping CREATE EXTENSION vector';
  END IF;
END
$$;
