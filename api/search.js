export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, radius = 40 } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  const RIDB_KEY   = process.env.RIDB_API_KEY;
  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;
  const results    = [];

  // ── 1. Recreation.gov (RIDB) ─────────────────────────────────────────────
  if (RIDB_KEY) {
    try {
      const url = `https://ridb.recreation.gov/api/v1/campgrounds` +
        `?latitude=${lat}&longitude=${lon}&radius=${radius}` +
        `&apikey=${RIDB_KEY}&limit=10&full=true`;

      const r    = await fetch(url);
      const data = await r.json();

      (data.RECDATA || []).forEach(site => {
        const addr  = (site.ADDRESSES || [])[0] || {};
        const attrs = (site.CAMPSITE  || []);
        const desc  = (site.FacilityDescription || '')
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 220);

        // figure out electric hookup from description text
        const raw      = (site.FacilityDescription || '').toLowerCase();
        const hasElec  = raw.includes('electric') || raw.includes('hookup') || raw.includes('amp');
        const has30    = raw.includes('30 amp') || raw.includes('30-amp');
        const has50    = raw.includes('50 amp') || raw.includes('50-amp');
        let hookupStr  = 'No hookups (dry camping)';
        if (has30 && has50) hookupStr = '30/50 amp electric';
        else if (has30)     hookupStr = '30 amp electric';
        else if (has50)     hookupStr = '50 amp electric';
        else if (hasElec)   hookupStr = 'Electric hookups';

        results.push({
          name:       site.FacilityName,
          address:    [addr.AddressStateCode, addr.City].filter(Boolean).join(', '),
          source:     'recreation.gov',
          sourceLabel:'Recreation.gov',
          type:       'federal',
          lat:        site.FacilityLatitude,
          lon:        site.FacilityLongitude,
          bookingUrl: `https://www.recreation.gov/camping/campgrounds/${site.FacilityID}`,
          rating:     null,
          hookups:    hookupStr,
          pullThru:   'Check site',
          desc:       desc || 'Federal campground — see recreation.gov for full details.',
          reservable: site.Reservable,
        });
      });
    } catch (e) {
      console.error('RIDB error:', e.message);
    }
  }

  // ── 2. Google Places (Nearby Search) ────────────────────────────────────
  if (GOOGLE_KEY) {
    try {
      const radiusMeters = Math.round(radius * 1609.34);
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
        `?location=${lat},${lon}&radius=${radiusMeters}` +
        `&keyword=rv+park+campground&key=${GOOGLE_KEY}`;

      const r    = await fetch(url);
      const data = await r.json();

      (data.results || []).slice(0, 10).forEach(place => {
        const rating = place.rating
          ? `⭐ ${place.rating}/5 (${place.user_ratings_total} reviews)`
          : 'No rating yet';

        results.push({
          name:       place.name,
          address:    place.vicinity || '',
          source:     'google',
          sourceLabel:'Google Places',
          type:       'private',
          lat:        place.geometry.location.lat,
          lon:        place.geometry.location.lng,
          bookingUrl: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
          rating:     place.rating || null,
          ratingStr:  rating,
          hookups:    'Contact for hookup details',
          pullThru:   'Contact campground',
          desc:       rating,
          open:       place.opening_hours?.open_now,
        });
      });
    } catch (e) {
      console.error('Google Places error:', e.message);
    }
  }

  // sort: federal first, then by rating desc
  results.sort((a, b) => {
    if (a.type === 'federal' && b.type !== 'federal') return -1;
    if (b.type === 'federal' && a.type !== 'federal') return 1;
    return (b.rating || 0) - (a.rating || 0);
  });

  return res.status(200).json({ results: results.slice(0, 18) });
}
