-- 0005_messages_outbound_insert.sql
--
-- Adds an INSERT policy on `public.messages` that lets any authenticated
-- user (admin or regular user — both manage live conversations per the
-- product spec) send an OUTBOUND message from the dashboard.
--
-- Inbound messages (from the lead) continue to flow through the
-- service_role client used by n8n; they are not affected by this policy.
--
-- We deliberately do NOT scope this further to "messages whose
-- conversation belongs to my agent" because:
--   - The dashboard is internal; every authenticated user is staff.
--   - Per-agent scoping isn't enforced anywhere yet (it'll come together
--     with the user↔agent mapping in a later PR).
-- The `direction = 'outbound'` check is the meaningful safety net —
-- without it, a malicious authenticated user could fake inbound history.

-- ─────────────────────────────────────────────────────────────────────────
-- messages INSERT — authenticated, outbound only
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_send_outbound_messages" ON public.messages;
CREATE POLICY "authenticated_send_outbound_messages"
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (direction = 'outbound');
