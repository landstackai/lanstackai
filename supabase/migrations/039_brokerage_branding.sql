-- ─────────────────────────────────────────────────────────────────────────
-- Brokerage branding + agent profile fields.
--
-- Adds the data model needed for:
--   • Branded PDF reports (team logo + brokerage name + address on cover,
--     agent name + title + license + phone on footer)
--   • A real Settings/Brokerage page where admins can edit company info
--   • The "designated broker" / "agent" distinction TREC requires —
--     brokerage holds the license, individual agents hold their own
--
-- Schema choices:
--   1. Address split into address + suite + city + state + zip rather than
--      one big TEXT field. Required for canonical formatting on reports
--      (e.g. line 1 = "8620 N New Braunfels Ave, Ste 115", line 2 =
--      "San Antonio, TX 78217"). Single-field addresses can't be split
--      reliably after the fact.
--   2. license_number on BOTH teams and profiles. TREC brokerage license
--      is the entity's number (9007406 for W&S Ranches LLC). Each agent
--      under that brokerage has their own license (638074 for Louie as
--      designated broker; Christina has her own). Reports show BOTH —
--      brokerage at top, agent at bottom.
--   3. role check expanded to include 'owner'. The user who created the
--      team is the owner — can't be removed by other admins, sees Billing,
--      ultimate authority. Previously only 'admin' | 'member' was allowed.
--   4. primary_color reserved for future PDF brand accent. Optional;
--      reports use a neutral default when null.
--
-- All new fields are NULLABLE so existing rows (Louie's profile, etc.)
-- don't break and can be filled in piecewise via the Settings UI.
-- ─────────────────────────────────────────────────────────────────────────

-- ── teams (brokerage-level info) ────────────────────────────────────────
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS suite TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS zip TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS primary_color TEXT;

COMMENT ON COLUMN teams.license_number IS
  'Brokerage TREC license number (entity-level). e.g. 9007406 for W&S Ranches LLC.';
COMMENT ON COLUMN teams.logo_url IS
  'Public URL to the brokerage logo in Supabase Storage (bucket: team-logos). Rendered on PDF report covers.';

-- ── profiles (agent-level info) ─────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT;

COMMENT ON COLUMN profiles.title IS
  'Agent title — REALTOR®, Broker Associate, Salesperson, Designated Broker, etc. Free text.';
COMMENT ON COLUMN profiles.license_number IS
  'Individual TREC license number (agent-level). Distinct from teams.license_number which is the brokerage entity.';

-- ── role: add 'owner' to the allowed values ─────────────────────────────
-- The user who creates a team is the owner. Owner is implicit (not enforced
-- by FK), so the role column doesn't UNIQUE on team_id; we just allow
-- the value.
DO $$
BEGIN
  -- Drop the legacy constraint that only allowed admin/member.
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
EXCEPTION WHEN OTHERS THEN
  -- Constraint name varies across older schemas; ignore if it doesn't exist.
  NULL;
END $$;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('owner', 'admin', 'member'));
