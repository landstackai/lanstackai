export type VisibilityLevel = 'private' | 'team' | 'shared';
export type CompStatus = 'Sold' | 'Active' | 'Pending' | 'Withdrawn';
export type WaterQuality = 'None' | 'Seasonal' | 'Strong';
export type RoadFrontage = 'None' | 'Low' | 'Medium' | 'High';
export type DevPotential = 'Low' | 'Medium' | 'High';
export type BestUse = 'Recreational' | 'Agriculture' | 'Investment' | 'Development' | 'Conservation' | 'Timber';
export type ConfidenceLevel = 'Verified' | 'Estimated' | 'Unverified';
export type ImprovementType = 'main_house' | 'guest_cabin' | 'horse_barn' | 'hay_barn' | 'equipment_barn' | 'shop' | 'hunting_cabin' | 'foreman_house' | 'pool' | 'other';
export type QualityClass = 'Basic' | 'Good' | 'High-End' | 'Luxury';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  brokerage_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  team_id: string | null;
  role: 'admin' | 'member';
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface Comp {
  id: string;
  created_by: string;
  team_id: string | null;
  
  // Core
  property_name: string | null;
  status: CompStatus;
  county: string;
  state: string;
  acres: number;
  sale_price: number;
  price_per_acre: number;
  sale_date: string;
  
  // Improvement pricing
  total_sale_price: number | null;
  improvements_value: number | null;
  price_land_only: number | null;
  ppa_total: number | null;
  ppa_land_only: number | null;
  has_improvements: boolean;
  use_land_only_for_cma: boolean;
  
  // Location
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  parcel_id: string | null;
  parcel_ids: string[] | null;
  parcel_boundary: any | null;
  
  // Value drivers
  water: WaterQuality;
  road_frontage: RoadFrontage;
  dev_potential: DevPotential;
  best_use: BestUse[];
  topography: string | null;
  improvements_notes: string | null;
  
  // Texas specific
  minerals_sold: string | null;
  ag_exemption: boolean;
  wildlife_notes: string | null;
  flood_plain_pct: number | null;
  
  // Transaction
  grantor: string | null;
  grantee: string | null;
  financing: string | null;
  recording_number: string | null;
  confirmation_source: string | null;
  sale_id_external: string | null;
  
  // Prior sale
  prior_sale_date: string | null;
  prior_sale_price: number | null;
  
  // Meta
  description: string | null;
  source_url: string | null;
  tags: string[] | null;
  visibility: VisibilityLevel;
  confidence: ConfidenceLevel;
  is_company_transaction: boolean;
  is_draft: boolean;
  
  // Source links
  source_links: SourceLink[] | null;
  
  created_at: string;
  updated_at: string;
}

export interface SourceLink {
  id: string;
  comp_id: string;
  url: string;
  source_name: string;
  source_type: 'listing' | 'deed' | 'auction' | 'news' | 'cad';
  verification_score: number;
  broker_verified: boolean;
  is_primary: boolean;
  page_title: string | null;
  thumbnail_url: string | null;
}

export interface CompImprovement {
  id: string;
  comp_id: string;
  improvement_type: ImprovementType;
  square_footage: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  quality_class: QualityClass;
  year_built: number | null;
  condition: string | null;
  ecv_value: number | null;
  notes: string | null;
}

export interface CMA {
  id: string;
  created_by: string;
  team_id: string | null;
  
  // Subject property
  subject_name: string;
  subject_address: string | null;
  subject_county: string;
  subject_state: string;
  subject_acres: number;
  subject_description: string | null;
  client_name: string | null;
  
  // Results
  value_low: number | null;
  value_mid: number | null;
  value_high: number | null;
  ppa_low: number | null;
  ppa_mid: number | null;
  ppa_high: number | null;
  
  // Settings
  cma_mode: 'land_only' | 'improved' | 'both';
  broker_notes: string | null;
  
  // Sharing
  share_token: string | null;
  share_expires_at: string | null;
  
  selected_comp_ids: string[];
  
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  comps?: Partial<Comp>[];
}

export interface ExtractedComp {
  property_name: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;
  sale_price: number | null;
  price_land_only: number | null;
  improvements_value: number | null;
  price_per_acre: number | null;
  ppa_land_only: number | null;
  sale_date: string | null;
  status: CompStatus | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  parcel_id: string | null;
  recording_number: string | null;
  grantor: string | null;
  grantee: string | null;
  financing: string | null;
  minerals_sold: string | null;
  confirmation_source: string | null;
  sale_id_external: string | null;
  water: WaterQuality | null;
  road_frontage: RoadFrontage | null;
  improvements_notes: string | null;
  description: string | null;
  flood_plain_pct: number | null;
  wildlife_notes: string | null;
  prior_sale_date: string | null;
  prior_sale_price: number | null;
  has_improvements: boolean;
  confidence: {
    overall: number;
    per_field: Record<string, number>;
  };
  document_type: string;
  is_subject_property: boolean;
  is_comparable: boolean;
}

export interface CompFilters {
  search: string;
  county: string;
  status: CompStatus | '';
  min_acres: string;
  max_acres: string;
  min_ppa: string;
  max_ppa: string;
  water: WaterQuality | '';
  dev_potential: DevPotential | '';
  visibility: VisibilityLevel | '';
  is_company_transaction: boolean | null;
  scope: 'all' | 'mine' | 'team';
}
