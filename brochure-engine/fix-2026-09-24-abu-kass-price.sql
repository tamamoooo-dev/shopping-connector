-- 2026-09-24: Abu Kass basmati rice 10kg (alwafa, two brochures) was accepted by the
-- Mistral price fallback as 29.99 (was 72.99). The crop shows 72.99, with 89.99 crossed out.
-- Guarded: rows change only if they still hold the wrong values.
UPDATE offers SET price = 72.99, old_price = 89.99
 WHERE id IN ('alwafa:central:d4d:97679961', 'alwafa:central:d4d:97647816')
   AND price = 29.99 AND old_price = 72.99;
UPDATE price_pending SET price = 72.99, old_price = 89.99
 WHERE offer_id IN ('97679961', '97647816')
   AND status = 'accepted' AND price = 29.99;
