'use client';

// ─────────────────────────────────────────────────────────────────────────
// TieredLoadingMessage
//
// Three-tier loading display used during long-running AI operations
// (PDF extraction, auto-locate, AI search, etc):
//
//   Tier 1 — Brand voice: a friendly rotating line that signals "we're
//            working" without being clinical. Rotates every ~4s so users
//            see motion even when the operation is on one long step.
//
//   Tier 2 — Specific status: optional, set by the caller to describe
//            what's actually happening ("Reading PDF page 3 of 5…").
//            Skip when there's nothing meaningful to surface.
//
//   Tier 3 — Tips: rotate every ~6s but ONLY after the operation has
//            been running 15s+. Genuinely useful workflow nuggets,
//            not marketing fluff.
//
// Use anywhere an AI op takes more than ~2 seconds. Below 2s, just use
// a spinner — the tiered messages won't have time to settle and will
// flash distractingly.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

// Friendly framing lines. Rotate through these every 4s so the same
// line doesn't sit on screen for 30 seconds and feel frozen. Kept warm
// and broker-targeted — these are professionals working with appraisals,
// not consumers playing a game.
const BRAND_VOICE = [
  "Landstack is working hard so you don't have to…",
  "Reading the appraisal so you don't have to skim it…",
  "Doing the math…",
  "Mapping this out…",
  "Pulling the pieces together…",
];

// Workflow tips that surface after a long-ish wait. Each one should
// teach the broker something they probably didn't know but would
// actually use. NO marketing copy. NO "did you know we have feature X."
// If it's not a real workflow insight, it doesn't go here.
const TIPS = [
  "Tip: Hover any boundary on the map to see acreage and $/ac.",
  "Tip: Multi-county comps appear under each county in the vault.",
  "Tip: \"Merge into existing\" picks up missing fields like aerials, parcel IDs, and coordinates without overwriting verified data.",
  "Tip: The math gate catches when extracted acres × $/ac doesn't match sale price.",
  "Tip: Drawing a boundary by hand takes ~30 seconds — use the Draw tool on the review page when TxGIO doesn't have the right parcels.",
  "Tip: Re-importing a PDF triggers the duplicate detector — use Merge to update the existing comp with fresh fields.",
  "Tip: The County filter splits compound counties — \"Atascosa, Frio\" shows under both Atascosa and Frio.",
];

// Threshold for tips to appear (ms). Below this, the operation is fast
// enough that a tip would be noise.
const TIP_DELAY_MS = 15_000;

export function TieredLoadingMessage({
  status,
  showTips = true,
}: {
  status?: string | null;
  showTips?: boolean;
}) {
  // Brand-line index. Advances every 4s. Starts at a random index so
  // back-to-back loads don't always start with the same line.
  const [brandIdx, setBrandIdx] = useState(() =>
    Math.floor(Math.random() * BRAND_VOICE.length)
  );
  // Tip index. Advances every 6s. Same random-start treatment.
  const [tipIdx, setTipIdx] = useState(() => Math.floor(Math.random() * TIPS.length));
  // Have we been loading long enough for tips to show?
  const [elapsedEnough, setElapsedEnough] = useState(false);

  useEffect(() => {
    const brandInterval = setInterval(() => {
      setBrandIdx((i) => (i + 1) % BRAND_VOICE.length);
    }, 4_000);
    const tipInterval = setInterval(() => {
      setTipIdx((i) => (i + 1) % TIPS.length);
    }, 6_000);
    const tipDelayTimer = setTimeout(() => setElapsedEnough(true), TIP_DELAY_MS);
    return () => {
      clearInterval(brandInterval);
      clearInterval(tipInterval);
      clearTimeout(tipDelayTimer);
    };
  }, []);

  return (
    <div className="flex flex-col gap-1">
      {/* Tier 1: brand voice */}
      <div className="text-sm text-slate-200 font-medium">{BRAND_VOICE[brandIdx]}</div>
      {/* Tier 2: specific status (optional) */}
      {status && (
        <div className="text-xs text-slate-400 flex items-center gap-1.5">
          <span className="inline-block w-1 h-1 rounded-full bg-sage animate-pulse" />
          {status}
        </div>
      )}
      {/* Tier 3: tip (only after the long-wait threshold) */}
      {showTips && elapsedEnough && (
        <div className="text-[11px] text-slate-500 italic mt-1 leading-relaxed">
          {TIPS[tipIdx]}
        </div>
      )}
    </div>
  );
}
