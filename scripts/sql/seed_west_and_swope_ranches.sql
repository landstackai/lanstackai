-- ─────────────────────────────────────────────────────────────────────────
-- West and Swope Ranches — seed data for Landstack's first brokerage.
--
-- Idempotent: re-running creates nothing duplicate, only fills in fields
-- that are currently NULL. Safe to run multiple times during onboarding
-- or after fixing typos.
--
-- Prerequisite: migration 039_brokerage_branding.sql has been applied.
--
-- Values sourced from:
--   • TREC license database (verified 2026-06-17): brokerage license
--     9007406, designated broker Louis James Swope license 638074.
--   • Louie confirmed mailing address as 8620 N New Braunfels Ave Ste 115,
--     San Antonio TX 78217 (TREC has the same; he initially said 78209
--     but USPS confirms the block lies in 78217).
--
-- Phone left NULL — Louie to add via the Settings page once it ships,
-- or by re-running this script with the phone literal substituted in.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_user_id UUID;
  v_team_id UUID;
BEGIN
  -- 1. Find Louie's auth.users row by email.
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = 'lswope@westandswoperanches.com'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No auth user found for lswope@westandswoperanches.com. Log in once at landstackai.vercel.app to create the auth row, then re-run this script.';
  END IF;

  -- 2. Find or create the team.
  SELECT id INTO v_team_id
  FROM teams
  WHERE name = 'West and Swope Ranches'
  LIMIT 1;

  IF v_team_id IS NULL THEN
    INSERT INTO teams (
      name, created_by,
      address, suite, city, state, zip,
      website, license_number
    ) VALUES (
      'West and Swope Ranches', v_user_id,
      '8620 N New Braunfels Ave', 'Ste 115', 'San Antonio', 'TX', '78217',
      'https://westandswoperanches.com', '9007406'
    )
    RETURNING id INTO v_team_id;

    RAISE NOTICE 'Created team % for user %', v_team_id, v_user_id;
  ELSE
    -- Backfill any NULL fields without overwriting good data. COALESCE
    -- preserves whatever's already set.
    UPDATE teams SET
      address        = COALESCE(address,        '8620 N New Braunfels Ave'),
      suite          = COALESCE(suite,          'Ste 115'),
      city           = COALESCE(city,           'San Antonio'),
      state          = COALESCE(state,          'TX'),
      zip            = COALESCE(zip,            '78217'),
      website        = COALESCE(website,        'https://westandswoperanches.com'),
      license_number = COALESCE(license_number, '9007406')
    WHERE id = v_team_id;

    RAISE NOTICE 'Updated team % (backfill only, no overwrites)', v_team_id;
  END IF;

  -- 3. Ensure Louie's profile is linked + filled in. ON CONFLICT keeps
  -- existing values via COALESCE (won't clobber name/title/etc. if he
  -- already set them elsewhere).
  INSERT INTO profiles (
    id, team_id, role, brokerage_name,
    full_name, title, license_number
  ) VALUES (
    v_user_id, v_team_id, 'owner', 'West and Swope Ranches',
    'Louie Swope', 'Designated Broker', '638074'
  )
  ON CONFLICT (id) DO UPDATE SET
    team_id        = EXCLUDED.team_id,
    role           = 'owner',
    brokerage_name = COALESCE(profiles.brokerage_name, EXCLUDED.brokerage_name),
    full_name      = COALESCE(profiles.full_name,      EXCLUDED.full_name),
    title          = COALESCE(profiles.title,          EXCLUDED.title),
    license_number = COALESCE(profiles.license_number, EXCLUDED.license_number);

  RAISE NOTICE 'Linked % to team % as owner', v_user_id, v_team_id;
END
$$;

-- ─── Verification ───────────────────────────────────────────────────────
SELECT
  t.name AS brokerage,
  t.license_number AS brokerage_license,
  t.address || COALESCE(', ' || t.suite, '') AS street,
  t.city || ', ' || t.state || ' ' || t.zip AS city_state_zip,
  t.website,
  p.full_name AS agent,
  p.title AS agent_title,
  p.license_number AS agent_license,
  p.role,
  u.email
FROM teams t
JOIN profiles p ON p.team_id = t.id
JOIN auth.users u ON u.id = p.id
WHERE t.name = 'West and Swope Ranches';
