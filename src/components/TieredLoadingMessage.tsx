'use client';

// ─────────────────────────────────────────────────────────────────────────
// TieredLoadingMessage
//
// Two-tier loading display used during long-running AI operations
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
// Use anywhere an AI op takes more than ~2 seconds. Below 2s, just use
// a spinner — the rotating brand line won't have time to settle and
// will flash distractingly.
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

export function TieredLoadingMessage({
  status,
}: {
  status?: string | null;
}) {
  // Brand-line index. Advances every 4s. Starts at a random index so
  // back-to-back loads don't always start with the same line.
  const [brandIdx, setBrandIdx] = useState(() =>
    Math.floor(Math.random() * BRAND_VOICE.length)
  );

  useEffect(() => {
    const brandInterval = setInterval(() => {
      setBrandIdx((i) => (i + 1) % BRAND_VOICE.length);
    }, 4_000);
    return () => clearInterval(brandInterval);
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
    </div>
  );
}
