-- ============================================
-- LANDSTACK AI — Complete Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ============================================
-- TEAMS
-- ============================================
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PROFILES
-- ============================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  brokerage_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  team_id UUID REFERENCES teams(id),
  role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  writing_style JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- COMPS
-- ============================================
CREATE TABLE comps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id),
  
  -- Core fields
  property_name TEXT,
  status TEXT DEFAULT 'Sold' CHECK (status IN ('Sold', 'Active', 'Pending', 'Withdrawn')),
  county TEXT NOT NULL,
  state TEXT DEFAULT 'TX',
  acres NUMERIC(10,2) NOT NULL,
  sale_price NUMERIC(14,2) NOT NULL,
  price_per_acre NUMERIC(12,2) GENERATED ALWAYS AS (
    CASE WHEN acres > 0 THEN sale_price / acres ELSE NULL END
  ) STORED,
  sale_date DATE,
  
  -- Improvement pricing
  total_sale_price NUMERIC(14,2),
  improvements_value NUMERIC(14,2),
  price_land_only NUMERIC(14,2) GENERATED ALWAYS AS (
    CASE WHEN improvements_value IS NOT NULL 
    THEN sale_price - improvements_value 
    ELSE sale_price END
  ) STORED,
  ppa_total NUMERIC(12,2) GENERATED ALWAYS AS (
    CASE WHEN acres > 0 THEN sale_price / acres ELSE NULL END
  ) STORED,
  ppa_land_only NUMERIC(12,2) GENERATED ALWAYS AS (
    CASE WHEN acres > 0 AND improvements_value IS NOT NULL 
    THEN (sale_price - improvements_value) / acres
    WHEN acres > 0 THEN sale_price / acres
    ELSE NULL END
  ) STORED,
  has_improvements BOOLEAN DEFAULT false,
  use_land_only_for_cma BOOLEAN DEFAULT true,
  
  -- Location
  address TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  parcel_id TEXT,
  parcel_ids TEXT[],
  parcel_boundary GEOMETRY(POLYGON, 4326),
  
  -- Value drivers
  water TEXT DEFAULT 'None' CHECK (water IN ('None', 'Seasonal', 'Strong')),
  road_frontage TEXT DEFAULT 'None' CHECK (road_frontage IN ('None', 'Low', 'Medium', 'High')),
  dev_potential TEXT DEFAULT 'Low' CHECK (dev_potential IN ('Low', 'Medium', 'High')),
  best_use TEXT[] DEFAULT '{}',
  topography TEXT,
  improvements_notes TEXT,
  
  -- Texas specific
  minerals_sold TEXT,
  ag_exemption BOOLEAN DEFAULT false,
  wildlife_notes TEXT,
  flood_plain_pct NUMERIC(5,2),
  
  -- Transaction details
  grantor TEXT,
  grantee TEXT,
  financing TEXT,
  recording_number TEXT,
  confirmation_source TEXT,
  sale_id_external TEXT,
  
  -- Prior sale
  prior_sale_date DATE,
  prior_sale_price NUMERIC(14,2),
  
  -- Meta
  description TEXT,
  source_url TEXT,
  tags TEXT[] DEFAULT '{}',
  visibility TEXT DEFAULT 'team' CHECK (visibility IN ('private', 'team', 'shared')),
  confidence TEXT DEFAULT 'Unverified' CHECK (confidence IN ('Verified', 'Estimated', 'Unverified')),
  is_company_transaction BOOLEAN DEFAULT false,
  is_draft BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- COMP IMPROVEMENTS
-- ============================================
CREATE TABLE comp_improvements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comp_id UUID NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  improvement_type TEXT NOT NULL CHECK (improvement_type IN (
    'main_house', 'guest_cabin', 'horse_barn', 'hay_barn', 
    'equipment_barn', 'shop', 'hunting_cabin', 'foreman_house', 
    'pool', 'other'
  )),
  square_footage NUMERIC(10,2),
  bedrooms INTEGER,
  bathrooms NUMERIC(4,1),
  quality_class TEXT DEFAULT 'Good' CHECK (quality_class IN ('Basic', 'Good', 'High-End', 'Luxury')),
  year_built INTEGER,
  condition TEXT,
  ecv_value NUMERIC(14,2),
  replacement_cost_psf NUMERIC(8,2),
  replacement_cost_new NUMERIC(14,2),
  effective_age INTEGER,
  economic_life INTEGER,
  depreciation_pct NUMERIC(5,2),
  system_ecv NUMERIC(14,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- COMP SOURCE LINKS
-- ============================================
CREATE TABLE comp_source_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comp_id UUID NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source_name TEXT,
  source_type TEXT CHECK (source_type IN ('listing', 'deed', 'auction', 'news', 'cad')),
  verification_score INTEGER DEFAULT 0,
  broker_verified BOOLEAN DEFAULT false,
  is_primary BOOLEAN DEFAULT false,
  page_title TEXT,
  thumbnail_url TEXT,
  is_active BOOLEAN DEFAULT true,
  date_found TIMESTAMPTZ DEFAULT NOW(),
  date_verified TIMESTAMPTZ
);

-- ============================================
-- COMP FILES
-- ============================================
CREATE TABLE comp_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comp_id UUID NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CMAs
-- ============================================
CREATE TABLE cmas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id),
  
  -- Subject property
  subject_name TEXT NOT NULL,
  subject_address TEXT,
  subject_county TEXT NOT NULL,
  subject_state TEXT DEFAULT 'TX',
  subject_acres NUMERIC(10,2) NOT NULL,
  subject_description TEXT,
  client_name TEXT,
  
  -- Results
  value_low NUMERIC(14,2),
  value_mid NUMERIC(14,2),
  value_high NUMERIC(14,2),
  ppa_low NUMERIC(12,2),
  ppa_mid NUMERIC(12,2),
  ppa_high NUMERIC(12,2),
  
  -- Settings
  cma_mode TEXT DEFAULT 'land_only' CHECK (cma_mode IN ('land_only', 'improved', 'both')),
  broker_notes TEXT,
  
  -- Sharing
  share_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  share_expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  share_views INTEGER DEFAULT 0,
  
  selected_comp_ids UUID[] DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CMA CLIENT ACTIVITY
-- ============================================
CREATE TABLE cma_client_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cma_id UUID NOT NULL REFERENCES cmas(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  time_spent_seconds INTEGER,
  comp_reactions JSONB DEFAULT '{}',
  questions JSONB DEFAULT '[]'
);

-- ============================================
-- ACTIVE LISTINGS (from Land.com, MLS, etc)
-- ============================================
CREATE TABLE active_listings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT,
  source_id TEXT,
  source_url TEXT,
  property_name TEXT,
  address TEXT,
  county TEXT,
  state TEXT,
  acres NUMERIC(10,2),
  asking_price NUMERIC(14,2),
  asking_ppa NUMERIC(12,2) GENERATED ALWAYS AS (
    CASE WHEN acres > 0 THEN asking_price / acres ELSE NULL END
  ) STORED,
  list_date DATE,
  days_on_market INTEGER,
  status TEXT DEFAULT 'active',
  price_history JSONB DEFAULT '[]',
  water TEXT,
  has_improvements BOOLEAN DEFAULT false,
  improvement_notes TEXT,
  description TEXT,
  photos JSONB DEFAULT '[]',
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  score_letter TEXT,
  score_label TEXT,
  score_pct_vs_comp NUMERIC(8,2),
  comp_low_ppa NUMERIC(12,2),
  comp_mid_ppa NUMERIC(12,2),
  comp_high_ppa NUMERIC(12,2),
  comp_count INTEGER,
  score_confidence TEXT,
  last_scored TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MARKET INTELLIGENCE (anonymous, aggregated)
-- ============================================
CREATE TABLE market_intelligence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  state TEXT NOT NULL,
  county TEXT NOT NULL,
  property_type TEXT,
  acres_band TEXT,
  price_per_acre NUMERIC(12,2),
  ppa_land_only NUMERIC(12,2),
  sale_month INTEGER,
  sale_year INTEGER,
  water_quality TEXT,
  road_frontage TEXT,
  dev_potential TEXT,
  best_use_category TEXT,
  has_improvements BOOLEAN,
  improvement_quality TEXT,
  confidence_weight NUMERIC(3,2) DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE comps ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp_improvements ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE cmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cma_client_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_listings ENABLE ROW LEVEL SECURITY;

-- Profiles: users can see their own profile
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Teams: team members can see their team
CREATE POLICY "Team members can view their team" ON teams
  FOR SELECT USING (
    id IN (SELECT team_id FROM profiles WHERE id = auth.uid())
  );

-- Comps: visibility-based RLS
CREATE POLICY "Users can view their own comps" ON comps
  FOR SELECT USING (created_by = auth.uid());

CREATE POLICY "Users can view team comps" ON comps
  FOR SELECT USING (
    visibility IN ('team', 'shared') AND
    team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Users can view shared comps" ON comps
  FOR SELECT USING (visibility = 'shared');

CREATE POLICY "Users can insert comps" ON comps
  FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can update their own comps" ON comps
  FOR UPDATE USING (created_by = auth.uid());

CREATE POLICY "Users can delete their own comps" ON comps
  FOR DELETE USING (created_by = auth.uid());

-- Comp improvements: follow comp visibility
CREATE POLICY "Users can view comp improvements" ON comp_improvements
  FOR SELECT USING (
    comp_id IN (SELECT id FROM comps WHERE created_by = auth.uid() OR visibility IN ('team', 'shared'))
  );
CREATE POLICY "Users can manage improvements for own comps" ON comp_improvements
  FOR ALL USING (
    comp_id IN (SELECT id FROM comps WHERE created_by = auth.uid())
  );

-- Source links: same as improvements
CREATE POLICY "Users can view source links" ON comp_source_links
  FOR SELECT USING (
    comp_id IN (SELECT id FROM comps WHERE created_by = auth.uid() OR visibility IN ('team', 'shared'))
  );
CREATE POLICY "Users can manage source links for own comps" ON comp_source_links
  FOR ALL USING (
    comp_id IN (SELECT id FROM comps WHERE created_by = auth.uid())
  );

-- CMAs
CREATE POLICY "Users can view own CMAs" ON cmas
  FOR SELECT USING (created_by = auth.uid());
CREATE POLICY "Users can insert CMAs" ON cmas
  FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "Users can update own CMAs" ON cmas
  FOR UPDATE USING (created_by = auth.uid());
CREATE POLICY "Users can delete own CMAs" ON cmas
  FOR DELETE USING (created_by = auth.uid());

-- Active listings: all authenticated users can view
CREATE POLICY "Authenticated users can view active listings" ON active_listings
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_comps_updated_at
  BEFORE UPDATE ON comps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_cmas_updated_at
  BEFORE UPDATE ON cmas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-populate market intelligence (anonymous)
CREATE OR REPLACE FUNCTION populate_market_intelligence()
RETURNS TRIGGER AS $$
DECLARE
  acres_band TEXT;
  confidence NUMERIC;
BEGIN
  -- Calculate acres band
  acres_band := CASE
    WHEN NEW.acres < 100 THEN '0-100'
    WHEN NEW.acres < 300 THEN '100-300'
    WHEN NEW.acres < 500 THEN '300-500'
    WHEN NEW.acres < 1000 THEN '500-1000'
    ELSE '1000+'
  END;
  
  -- Calculate confidence weight
  confidence := CASE NEW.confidence
    WHEN 'Verified' THEN 1.0
    WHEN 'Estimated' THEN 0.7
    ELSE 0.3
  END;
  
  -- Insert anonymized record
  INSERT INTO market_intelligence (
    state, county, property_type, acres_band,
    price_per_acre, ppa_land_only,
    sale_month, sale_year,
    water_quality, road_frontage, dev_potential,
    has_improvements, confidence_weight
  ) VALUES (
    NEW.state, NEW.county, 
    CASE WHEN NEW.has_improvements THEN 'improved' ELSE 'land_only' END,
    acres_band,
    NEW.price_per_acre, NEW.ppa_land_only,
    EXTRACT(MONTH FROM NEW.sale_date)::INTEGER,
    EXTRACT(YEAR FROM NEW.sale_date)::INTEGER,
    NEW.water, NEW.road_frontage, NEW.dev_potential,
    NEW.has_improvements, confidence
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER populate_intelligence_on_comp_insert
  AFTER INSERT ON comps
  FOR EACH ROW 
  WHEN (NEW.status = 'Sold' AND NOT NEW.is_draft)
  EXECUTE FUNCTION populate_market_intelligence();

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_comps_created_by ON comps(created_by);
CREATE INDEX idx_comps_team_id ON comps(team_id);
CREATE INDEX idx_comps_county ON comps(county);
CREATE INDEX idx_comps_status ON comps(status);
CREATE INDEX idx_comps_visibility ON comps(visibility);
CREATE INDEX idx_comps_sale_date ON comps(sale_date);
CREATE INDEX idx_comps_location ON comps(latitude, longitude);
CREATE INDEX idx_cmas_created_by ON cmas(created_by);
CREATE INDEX idx_cmas_share_token ON cmas(share_token);
CREATE INDEX idx_market_intel_county ON market_intelligence(state, county);
CREATE INDEX idx_active_listings_county ON active_listings(county);

-- ============================================
-- STORAGE BUCKETS
-- ============================================
INSERT INTO storage.buckets (id, name, public) 
VALUES ('comp-files', 'comp-files', false);

INSERT INTO storage.buckets (id, name, public)
VALUES ('comp-photos', 'comp-photos', true);

CREATE POLICY "Users can upload comp files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'comp-files' AND auth.role() = 'authenticated'
  );

CREATE POLICY "Users can view own comp files" ON storage.objects
  FOR SELECT USING (
    bucket_id IN ('comp-files', 'comp-photos') AND auth.role() = 'authenticated'
  );

CREATE POLICY "Public can view comp photos" ON storage.objects
  FOR SELECT USING (bucket_id = 'comp-photos');
