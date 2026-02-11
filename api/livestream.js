// Vercel Serverless Function: /api/livestream
// Returns { state, videoId, upcomingStartMs }
// Caches responses at Vercel’s edge to protect YouTube quota.

const API_KEY = process.env.YT_API_KEY;
const CHANNEL_ID = process.env.YT_CHANNEL_ID;

function setCors(res) {
  // Allow any site (including ChurchPlantMedia) to read this JSON.
  // This endpoint returns only public data (state + videoId + start time).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body, cacheSeconds) {
  setCors(res);
  res.setHeader(
    "Cache-Control",
    `s-maxage=${cacheSeconds}, stale-while-revalidate=30`
  );
  res.status(status).json(body);
}

async function fetchJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} :: ${t}`);
  return JSON.parse(t);
}

async function ytSearch(eventType, maxResults) {
  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    "?part=snippet" +
    "&channelId=" + encodeURIComponent(CHANNEL_ID) +
    "&type=video" +
    "&eventType=" + encodeURIComponent(eventType) +
    "&maxResults=" + encodeURIComponent(String(maxResults)) +
    "&key=" + encodeURIComponent(API_KEY);

  return fetchJson(url);
}

async function pickSoonestUpcoming(limit = 10) {
  const upcoming = await ytSearch("upcoming", limit);
  const ids = (upcoming.items || [])
    .map(x => x.id && x.id.videoId)
    .filter(Boolean);

  if (!ids.length) return null;

  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    "?part=liveStreamingDetails" +
    "&id=" + encodeURIComponent(ids.join(",")) +
    "&key=" + encodeURIComponent(API_KEY);

  const details = await fetchJson(url);
  const now = Date.now();

  const soonest = (details.items || [])
    .map(v => ({
      id: v.id,
      t: Date.parse(v.liveStreamingDetails?.scheduledStartTime || "")
    }))
    .filter(x => x.t && x.t > now)
    .sort((a, b) => a.t - b.t)[0];

  return soonest || null;
}

module.exports = async (req, res) => {
  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }

  const debug = req.query && String(req.query.debug || "") === "1";

  try {
    if (!API_KEY || !CHANNEL_ID) {
      return json(res, 500, { error: "Missing env vars" }, 60);
    }

    // 1) Live now
    const live = await ytSearch("live", 1);
    if (live.items && live.items.length) {
      const videoId = live.items[0].id.videoId;
      return json(res, 200, { state: "live", videoId, upcomingStartMs: null }, 30);
    }

    // 2) Upcoming
    const soonest = await pickSoonestUpcoming(10);
    if (soonest && soonest.id) {
      const diff = soonest.t - Date.now();
      const cacheSeconds =
        diff > 2 * 60 * 60 * 1000 ? 1800 :
        diff > 30 * 60 * 1000 ? 300 :
        30;

      return json(
        res,
        200,
        { state: "upcoming", videoId: soonest.id, upcomingStartMs: soonest.t },
        cacheSeconds
      );
    }

    // 3) Replay
    const completed = await ytSearch("completed", 1);
    if (completed.items && completed.items.length) {
      const videoId = completed.items[0].id.videoId;
      return json(res, 200, { state: "replay", videoId, upcomingStartMs: null }, 600);
    }

    return json(res, 200, { state: "none", videoId: null, upcomingStartMs: null }, 600);

  } catch (e) {
    if (debug) {
      setCors(res);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        state: "none",
        videoId: null,
        upcomingStartMs: null,
        debugError: String(e && e.message ? e.message : e)
      });
    }

    return json(res, 200, { state: "none", videoId: null, upcomingStartMs: null }, 600);
  }
};
