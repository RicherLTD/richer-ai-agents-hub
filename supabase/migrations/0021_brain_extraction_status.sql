-- 0021_brain_extraction_status.sql
--
-- Async extraction for brain_documents — fixes the 150s Edge function
-- timeout that blocked uploads of large PDFs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'brain_extraction_status'
  ) THEN
    CREATE TYPE public.brain_extraction_status AS ENUM ('pending', 'ready', 'failed');
  END IF;
END $$;

ALTER TABLE public.brain_documents
  ADD COLUMN IF NOT EXISTS extraction_status public.brain_extraction_status
    NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS extraction_error text;

CREATE INDEX IF NOT EXISTS brain_documents_extraction_status_idx
  ON public.brain_documents (extraction_status)
  WHERE extraction_status = 'pending';
