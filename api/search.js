module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, radius = 40, debug } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon required' });
  }

  const RIDB_KEY   = process.env.RIDB_API_KEY;
  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;

  // Debug mode — shows whether keys are loaded (never shows the key values)
  if (debug === '1') {
    return res.status(200).json({
      ridb_key_set:   !!RIDB_KEY,
      google_key_set: !!GOOGLE_KEY,
      lat, lon, radius,
      node_version: process.version,
    });
  }

  const results = [];
  const errors  = [];

  // ── 1. Recreation.gov RIDB ───────────────────────────────────────────────
  if (RIDB_KEY) {
    try {
      const ridbUrl =
        `https://ridb.recreation.gov/api/v1/campgrounds` +
        `?latitude=${lat}&longitude=${lon}&radius=${radius}` +
        `&apikey=${RIDB_KEY}&limit=10&full=true`;

      const r    = await fetch(ridbUrl);
      const text = await r.text();

      let data;
      try { data = JSON.parse(text); }
      catch { errors.push(`RIDB parse error: ${text.substring(0, 120)}`); data = {}; }

      (data.RECDATA || []).forEach(site => {
        const addr = (site.ADDRESSES || [])[0] || {};
        const raw  = (site.FacilityDescription || '').toLowerCase();
        const desc = (site.FacilityDescription || '')
          .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);

        let hookupStr = 'No hookups (dry camping)';
        if      (raw.includes('30') && raw.includes('50')) hookupStr = '30/50 amp electric';
        else if (raw.includes('50 amp'))                   hookupStr = '50 amp electric';
        else if (raw.includes('30 amp'))                   hookupStr = '30 amp electric';
        else if (raw.includes('electric') || raw.includes('hookup')) hookupStr = 'Electric hookups';

        results.push({
          name:        site.FacilityName,
          address:     [addr.City, addr.AddressStateCode].filter(Boolean).join(', '),
          source:      'recreation.gov',
          sourceLabel: 'Recreation.gov',
          type:        'federal',
          bookingUrl:  `https://www.recreation.gov/camping/campgrounds/${site.FacilityID}`,
          rating:      null,
          ratingStr:   null,
          hookups:     hookupStr,
          pullThru:    'Check site',
          desc:        desc || 'Federal campground — book at recreation.gov.',
        });
      });
    } catch (e) {
      errors.push(`RIDB error: ${e.message}`);
    }
  } else {
    errors.push('RIDB_API_KEY not set');
  }

  // ── 2. Google Places Nearby Search ──────────────────────────────────────
  if (GOOGLE_KEY) {
    try {
      const radiusM  = Math.round(Number(radius) * 1609.34);
      const googleUrl =
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
        `?location=${lat},${lon}&radius=${radiusM}` +
        `&keyword=rv+park+campground&key=${GOOGLE_KEY}`;

      const r    = await fetch(googleUrl);
      const text = await r.text();

      let data;
      try { data = JSON.parse(text); }
      catch { errors.push(`Google parse error: ${text.substring(0, 120)}`); data = {}; }

      if (data.error_message) errors.push(`Google API: ${data.error_message}`);

      (data.results || []).slice(0, 10).forEach(place => {
        const ratingStr = place.rating
          ? `⭐ ${place.rating}/5 (${place.user_ratings_total || 0} reviews)`
          : null;

        results.push({
          name:        place.name,
          address:     place.vicinity || '',
          source:      'google',
          sourceLabel: 'Google Places',
          type:        'private',
          bookingUrl:  `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
          rating:      place.rating || null,
          ratingStr,
          hookups:     'Contact campground for hookup details',
          pullThru:    'Contact campground',
          desc:        ratingStr || 'Private campground — see Google Maps for details.',
          open:        place.opening_hours?.open_now,
        });
      });
    } catch (e) {
      errors.push(`Google error: ${e.message}`);
    }
  } else {
    errors.push('GOOGLE_PLACES_KEY not set');
  }

  // Federal sites first, then by rating
  results.sort((a, b) => {
    if (a.type === 'federal' && b.type !== 'federal') return -1;
    if (b.type === 'federal' && a.type !== 'federal') return 1;
    return (b.rating || 0) - (a.rating || 0);
  });

  return res.status(200).json({
    results: results.slice(0, 18),
    ...(errors.length ? { errors } : {}),
  });
};
