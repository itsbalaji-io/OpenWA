/**
 * Route Fingerprint Extraction & Normalization
 * Detects flight itinerary routes (e.g. "CHENNAI -> AHMEDABAD" or "CHENNAI → AHMEDABAD · FARES")
 * and normalizes them into stable keys (e.g. "chennai->ahmedabad") to detect duplicate flyers.
 */

export function extractRouteFingerprint(text: string): string {
  if (!text) return '';
  const routes: string[] = [];
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const clean = rawLine.replace(/\*/g, '').trim();
    if (clean.includes('→') || clean.includes('->')) {
      const normalizedArrow = clean.replace(/->/g, '→');
      const parts = normalizedArrow.split('→');
      if (parts.length >= 2) {
        const origRaw = parts[0];
        const destRaw = parts[1].split('·')[0].split('•')[0].split('-')[0];

        const orig = origRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const dest = destRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();

        if (orig && dest) {
          routes.push(`${orig}->${dest}`);
        }
      }
    }
  }

  if (routes.length > 0) {
    const uniqueSorted = Array.from(new Set(routes)).sort();
    return uniqueSorted.join('|');
  }

  // Fallback for general text campaigns: alphanumeric fingerprint of first 80 chars
  const filtered = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (filtered.length >= 20) {
    return filtered.slice(0, 80);
  }
  return filtered;
}

/**
 * Extracts human-readable route chips for UI display
 * e.g. ["CHENNAI → AHMEDABAD", "MUMBAI → DELHI"]
 */
export function extractRouteDisplayList(text: string): string[] {
  if (!text) return [];
  const routes: string[] = [];
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const clean = rawLine.replace(/\*/g, '').trim();
    if (clean.includes('→') || clean.includes('->')) {
      const shortRoute = (clean.split('·')[0] || clean).trim();
      if (shortRoute && !routes.includes(shortRoute)) {
        routes.push(shortRoute);
      }
    }
  }
  return routes;
}

/**
 * Clean short summary title for card headers
 */
export function cleanSummary(caption: string, type: string = 'image'): string {
  if (!caption) return `Status (${type.charAt(0).toUpperCase() + type.slice(1)})`;
  const routes = extractRouteDisplayList(caption);
  if (routes.length === 1) return routes[0];
  if (routes.length > 1) return `${routes[0]} (+${routes.length - 1} more)`;
  const first = (caption.split('\n')[0] || '').trim().replace(/\*/g, '');
  return first ? (first.length > 40 ? `${first.slice(0, 37)}...` : first) : `Status (${type.charAt(0).toUpperCase() + type.slice(1)})`;
}
