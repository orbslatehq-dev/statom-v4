export interface ResolvedLocation {
  lat: number;
  lng: number;
  label: string;
  zoom?: number;
}

export interface PlaceSuggestion {
  id: string;
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}

function normalizeSriLankaPair(a: number, b: number): { lat: number; lng: number } | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // In Sri Lanka: lat is ~5.7..10.1, lng is ~79.3..82.2
  if (a >= 5.5 && a <= 10.3 && b >= 79.1 && b <= 82.4) {
    return { lat: a, lng: b };
  }
  if (b >= 5.5 && b <= 10.3 && a >= 79.1 && a <= 82.4) {
    return { lat: b, lng: a };
  }
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    return { lat: a, lng: b };
  }
  return null;
}

/**
 * Synchronous parser for full Google Maps URLs, DMS strings, or raw coordinates.
 */
export function parseCoordinatesOrGoogleUrl(text: string): ResolvedLocation | null {
  const raw = text.trim();
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  // 1. Exact Google Maps dropped pin (!3d<lat>!4d<lng>) — highest precision!
  const pin3d4d = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pin3d4d) {
    const pair = normalizeSriLankaPair(Number(pin3d4d[1]), Number(pin3d4d[2]));
    if (pair) {
      return { ...pair, label: 'Pinned Location', zoom: 19.5 };
    }
  }

  // Alternate !2d<lng>!3d<lat>
  const pin2d3d = decoded.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (pin2d3d) {
    const pair = normalizeSriLankaPair(Number(pin2d3d[2]), Number(pin2d3d[1]));
    if (pair) {
      return { ...pair, label: 'Pinned Location', zoom: 19.5 };
    }
  }

  // 2. Query / ll / q / center / search coordinates in Google Maps URLs
  const queryCoord = decoded.match(
    /(?:[?&](?:q|query|ll|center|daddr|saddr)=|\/maps\/search\/)\s*(-?\d+\.\d+)\s*[,+\s]\s*(-?\d+\.\d+)/i
  );
  if (queryCoord) {
    const pair = normalizeSriLankaPair(Number(queryCoord[1]), Number(queryCoord[2]));
    if (pair) {
      return { ...pair, label: 'Shared Pin', zoom: 19.5 };
    }
  }

  // 3. Viewport @lat,lng in Google Maps URL
  const atCoord = decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atCoord) {
    const pair = normalizeSriLankaPair(Number(atCoord[1]), Number(atCoord[2]));
    if (pair) {
      return { ...pair, label: 'Google Maps Pin', zoom: 19.4 };
    }
  }

  // 4. DMS Coordinates (e.g. 6°50'53.5"N 79°55'36.5"E)
  const dmsRegex =
    /(\d{1,3})\s*°\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:\.\d+)?)\s*["”″]?\s*([NSns])[\s,]+(\d{1,3})\s*°\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:\.\d+)?)\s*["”″]?\s*([EWew])/;
  const dms = decoded.match(dmsRegex);
  if (dms) {
    let lat = Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600;
    if (dms[4].toUpperCase() === 'S') lat = -lat;
    let lng = Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600;
    if (dms[8].toUpperCase() === 'W') lng = -lng;
    const pair = normalizeSriLankaPair(lat, lng);
    if (pair) {
      return { ...pair, label: 'GPS Pin', zoom: 19.5 };
    }
  }

  // 5. Raw decimal coordinate pair (e.g. "6.8482, 79.9268")
  const rawPair = decoded.match(/^\s*(-?\d{1,3}\.\d{2,})\s*[,\s]\s*(-?\d{1,3}\.\d{2,})\s*$/);
  if (rawPair) {
    const pair = normalizeSriLankaPair(Number(rawPair[1]), Number(rawPair[2]));
    if (pair) {
      return { ...pair, label: `${pair.lat.toFixed(5)}, ${pair.lng.toFixed(5)}`, zoom: 19.5 };
    }
  }

  return null;
}

export function looksLikeMapLink(text: string): boolean {
  const s = text.trim();
  return (
    /^https?:\/\//i.test(s) ||
    /(?:maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.)/i.test(s)
  );
}

/**
 * Resolves any Google Maps link (including shortened maps.app.goo.gl share links!)
 * or place query into exact [lat, lng] coordinates.
 */
export async function resolveInputOrMapLink(input: string): Promise<ResolvedLocation | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Direct coordinate or full Google Maps URL parse
  const direct = parseCoordinatesOrGoogleUrl(trimmed);
  if (direct) return direct;

  // 2. Shortened Google Maps Share Link (e.g. https://maps.app.goo.gl/... or goo.gl/maps/...)
  if (looksLikeMapLink(trimmed)) {
    const urlMatch = trimmed.match(/https?:\/\/\S+/i);
    const cleanUrl = urlMatch ? urlMatch[0] : `https://${trimmed}`;

    try {
      const resp = await fetch(`/api/resolve-map-link?url=${encodeURIComponent(cleanUrl)}`);
      if (resp.ok) {
        const { finalUrl, bodySnippet } = (await resp.json()) as {
          finalUrl?: string;
          bodySnippet?: string;
        };

        if (finalUrl) {
          const fromFinal = parseCoordinatesOrGoogleUrl(finalUrl);
          if (fromFinal) return fromFinal;
        }

        if (bodySnippet) {
          const fromBody = parseCoordinatesOrGoogleUrl(bodySnippet);
          if (fromBody) return fromBody;

          // Google HTML embed/meta coordinate array pattern e.g. [null,null,6.848212,79.926834]
          const arrMatch = bodySnippet.match(/\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/);
          if (arrMatch) {
            const pair = normalizeSriLankaPair(Number(arrMatch[1]), Number(arrMatch[2]));
            if (pair) return { ...pair, label: 'Shared Google Pin', zoom: 19.5 };
          }
        }

        // Extract place title from /maps/place/<Name>/ and geocode in Sri Lanka
        const placeMatch = (finalUrl || '').match(/\/maps\/place\/([^/?#]+)/);
        if (placeMatch) {
          const placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
          const hits = await searchSriLankaPlaces(placeName);
          if (hits.length > 0) {
            return {
              lat: hits[0].lat,
              lng: hits[0].lng,
              label: hits[0].title,
              zoom: 19.2,
            };
          }
        }
      }
    } catch {
      // Fall through to place search
    }
  }

  // 3. Place / Address search in Sri Lanka
  const places = await searchSriLankaPlaces(trimmed);
  if (places.length > 0) {
    return {
      lat: places[0].lat,
      lng: places[0].lng,
      label: places[0].title,
      zoom: 19.15,
    };
  }

  return null;
}

export async function searchSriLankaPlaces(query: string): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2 || looksLikeMapLink(q)) return [];

  try {
    let items: Array<{
      place_id?: number | string;
      lat: string;
      lon: string;
      name?: string;
      display_name: string;
    }> = [];

    const apiResp = await fetch(`/api/search-lk?q=${encodeURIComponent(q)}`);
    if (apiResp.ok) {
      items = await apiResp.json();
    }

    // Client-side direct Nominatim fallback if needed
    if (!Array.isArray(items) || items.length === 0) {
      const directResp = await fetch(
        `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
          q,
          countrycodes: 'lk',
          format: 'jsonv2',
          limit: '6',
        }).toString()}`
      );
      if (directResp.ok) {
        items = await directResp.json();
      }
    }

    if (!Array.isArray(items)) return [];

    return items.slice(0, 6).map((item, idx) => {
      const parts = (item.display_name || '').split(',').map((s) => s.trim());
      const title = item.name || parts[0] || q;
      const subtitle = parts.slice(1, 4).join(', ') || 'Sri Lanka';
      return {
        id: String(item.place_id ?? idx),
        title,
        subtitle,
        lat: Number(item.lat),
        lng: Number(item.lon),
      };
    });
  } catch {
    return [];
  }
}
