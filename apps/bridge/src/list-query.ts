// The category predicates mirror detail()/recipientIsCurrent, but filtering and
// pagination happen in PostgreSQL before any request details are materialized.
export const requestListQuery = `
WITH visible AS (
 SELECT r.*, CASE
 WHEN EXISTS (SELECT 1 FROM signing.request_parts p WHERE p.request_id=r.id AND
   (p.last_error IS NOT NULL AND p.last_error <> '' OR p.operation_state IN ('unknown','failed','discarded') OR p.projection->>'expired'='true' OR p.projection->>'status' IN ('CANCELLED','REJECTED'))) THEN 'attention'
 WHEN NOT EXISTS (SELECT 1 FROM signing.request_parts p WHERE p.request_id=r.id AND p.projection->>'status' IS DISTINCT FROM 'COMPLETED') THEN 'completed'
 WHEN EXISTS (SELECT 1 FROM signing.request_parts p WHERE p.request_id=r.id AND (p.projection IS NULL OR p.projection->>'status'='DRAFT')) THEN 'draft'
 WHEN EXISTS (
   SELECT 1 FROM signing.request_parts p CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.projection->'recipients','[]'::jsonb)) recipient
   WHERE p.request_id=r.id AND p.projection->>'status'='PENDING'
   AND recipient->>'role' <> 'CC' AND recipient->>'signingStatus'='NOT_SIGNED'
   AND (recipient->>'expiresAt' IS NULL OR (recipient->>'expiresAt')::timestamptz > NOW())
   AND lower(recipient->>'email')=ANY($6::text[])
   AND (r.scenario='custom' OR recipient->>'actor'='owner' AND r.owner_agent_id=$2 OR recipient->>'actor'='company' AND $7::boolean)
   AND (p.projection->>'signingOrder' IS DISTINCT FROM 'SEQUENTIAL' OR COALESCE((recipient->>'signingOrder')::int,1)=(
     SELECT MIN(COALESCE((other->>'signingOrder')::int,1)) FROM jsonb_array_elements(p.projection->'recipients') other
     WHERE other->>'role'<>'CC' AND other->>'signingStatus'='NOT_SIGNED'
   ))
 ) THEN 'mine' ELSE 'waiting' END AS category
 FROM signing.requests r
 WHERE r.client_id=$1 AND (r.owner_agent_id=$2 OR $4::boolean)
 AND (($4::boolean AND r.scenario IN ('onboarding','team_leader')) OR (NOT $4::boolean AND r.scenario IN ('buyer','seller','commercial','company_file','custom')))
 AND (r.title ILIKE $3 OR r.business->>'customer' ILIKE $3 OR r.business->>'property' ILIKE $3 OR EXISTS (
  SELECT 1 FROM signing.request_parts p CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.projection->'files','[]'::jsonb)) file
  WHERE p.request_id=r.id AND file->>'title' ILIKE $3
 ))
), matching AS (SELECT * FROM visible WHERE $5::text IS NULL OR category=$5),
paged AS (SELECT id,updated_at FROM matching ORDER BY updated_at DESC,id DESC LIMIT 30 OFFSET $8)
SELECT (SELECT COUNT(*)::int FROM matching) AS count,
 COALESCE((SELECT jsonb_agg(id ORDER BY updated_at DESC,id DESC) FROM paged),'[]'::jsonb) AS ids
`;
