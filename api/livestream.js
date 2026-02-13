// Vercel Serverless Function: /api/livestream
// Returns { state, videoId, upcomingStartMs, generatedAt, youtubeFetchedAt }
// Refactor: avoids YouTube search.list (expensive) by using:
// channels.list -> uploads playlistId, playlistItems.list -> recent videoIds, videos.list -> liveStreamingDetails
//
// Late-start fix (grace window):
// If a stream is scheduled to start at X but actually goes live a few minutes late,
// YouTube may not set actualStartTime immediately. Without a grace window, the code
// can incorrectly skip to the next upcoming event right after X.
// We treat "scheduledStartTime <= now <= scheduledStartTime + GRACE_MS" as still upcoming.

const API_KEY = process.env.YT_API_KEY;
const CHANNEL_ID = process.env.YT_CHANNEL_ID;

// Grace window for late starts (default: 10 minutes)
// You can override with env var YT_LATE_START_GRACE_MINUTES
const GRACE_MINUTES = Number(process.env.YT_LATE_START_GRACE_MINUTES || "10");
const GRACE_MS = Math.max(0, GRACE_MINUTES) * 60 * 1000;

// Cache uploads playlist ID across warm invocations (best-effort)
let cachedUploadsPlaylistId = null;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Adds caching headers + CORS, and returns JSON
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

async function getUploadsPlaylistId() {
  if (cachedUploadsPlaylistId) return cachedUploadsPlaylistId;

  const url =
    "https://www.googleapis.com/youtube/v3/channels" +
    "?part=contentDetails" +
    "&id=" + encodeURIComponent(CHANNEL_ID) +
    "&key=" + encodeURIComponent(API_KEY);

  const data = await fetchJson(url);
  const uploads =
    data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploads) throw new Error("Could not resolve uploads playlist ID");
  cachedUploadsPlaylistId = uploads;
  return uploads;
}

async function listRecentUploadVideoIds(maxResults = 20) {
  const uploadsPlaylistId = await getUploadsPlaylistId();

  const url =
    "https://www.googleapis.com/youtube/v3/playlistItems" +
    "?part=contentDetails" +
    "&playlistId=" + encodeURIComponent(uploadsPlaylistId) +
    "&maxResults=" + encodeURIComponent(String(maxResults)) +
    "&key=" + encodeURIComponent(API_KEY);

  const data = await fetchJson(url);
  return (data.items || [])
    .map((it) => it?.contentDetails?.videoId)
    .filter(Boolean);
}

async function getLiveStreamingDetails(ids) {
  if (!ids.length) return [];

  // Only request what we need for state selection
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    "?part=liveStreamingDetails" +
    "&id=" + encodeURIComponent(ids.join(",")) +
    "&key=" + encodeURIComponent(API_KEY);

  const data = await fetchJson(url);
  return data.items || [];
}

function pickStateFromVideos(videos) {
  const now = Date.now();

  // 1) Live now: actualStartTime exists and actualEndTime does not
  const liveNow = videos.find((v) => {
    const d = v.liveStreamingDetails;
    return d?.actualStartTime && !d?.actualEndTime;
  });
  if (liveNow) return { state: "live", videoId: liveNow.id, upcomingStartMs: null };

  // Build candidates with a scheduledStartTime (parseable)
  const scheduled = videos
    .map((v) => {
      const d = v.liveStreamingDetails;
      const t = Date.parse(d?.scheduledStartTime || "");
      return {
        id: v.id,
        t,
        hasActualStart: Boolean(d?.actualStartTime),
        hasActualEnd: Boolean(d?.actualEndTime),
      };
    })
    .filter((x) => Number.isFinite(x.t));

  // 2) Soonest upcoming in the future
  const upcomingFuture = scheduled
    .filter((x) => !x.hasActualEnd && x.t > now)
    .sort((a, b) => a.t - b.t)[0];

  // 2b) Late-start grace: scheduled time has passed, but within GRACE_MS,
  // and it's not ended and has not started (no actualStartTime yet).
  const upcomingGrace = scheduled
    .filter((x) => !x.hasActualEnd && !x.hasActualStart && x.t <= now && (now - x.t) <= GRACE_MS)
    .sort((a, b) => b.t - a.t)[0]; // prefer the most recent scheduled start

  // Prefer grace-window candidate over a far-future event (prevents skipping)
  const upcomingPick = upcomingGrace || upcomingFuture;

  if (upcomingPick) {
    return { state: "upcoming", videoId: upcomingPick.id, upcomingStartMs: upcomingPick.t };
  }

  // 3) Replay: most recent completed livestream (actualEndTime exists)
  const completed = videos
    .filter((v) => v.liveStreamingDetails?.actualEndTime)
    .sort((a, b) => {
      const ta = Date.parse(a.liveStreamingDetails.actualEndTime);
      const tb = Date.parse(b.liveStreamingDetails.actualEndTime);
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    })[0];

  if (completed) return { state: "replay", videoId: completed.id, upcomingStartMs: null };

  // Fallback: nothing found in the last N uploads
  return { state: "none", videoId: null, upcomingStartMs: null };
}

module.exports = async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }

  // We'll stamp the response so you can tell how "fresh" it is
  const generatedAt = new Date().toISOString();

  try {
    if (!API_KEY || !CHANNEL_ID) {
      return json(
        res,
        500,
        { error: "Missing env vars", state: "none", videoId: null, upcomingStartMs: null, generatedAt, youtubeFetchedAt: null },
        60
      );
    }

    // Fetch the most recent uploads (20 as discussed)
    const ids = await listRecentUploadVideoIds(20);
    const youtubeFetchedAt = new Date().toISOString();

    if (!ids.length) {
      return json(
        res,
        200,
        { state: "none", videoId: null, upcomingStartMs: null, generatedAt, youtubeFetchedAt },
        600
      );
    }

    // Get live streaming details for those uploads
    const videos = await getLiveStreamingDetails(ids);
    const result = pickStateFromVideos(videos);

    // Keep your smart caching strategy for upcoming streams (with late-start handling)
    if (result.state === "upcoming" && result.upcomingStartMs) {
      const diff = result.upcomingStartMs - Date.now(); // can be negative during grace window
      const absLate = diff < 0 ? Math.abs(diff) : 0;

      // If we're in the grace window (scheduled time just passed), poll very frequently
      if (diff <= 0 && absLate <= GRACE_MS) {
        return json(
          res,
          200,
          { ...result, generatedAt, youtubeFetchedAt },
          5 // 5s cache during sensitive transition
        );
      }

      const cacheSeconds =
        diff > 2 * 60 * 60 * 1000 ? 1800 : // >2h → 30 min
        diff > 30 * 60 * 1000 ? 300  :    // 30–120m → 5 min
        20;                               // <30m → 20s

      return json(
        res,
        200,
        { ...result, generatedAt, youtubeFetchedAt },
        cacheSeconds
      );
    }

    // Live can be checked frequently; replay/none can be longer.
    const cacheSeconds =
      result.state === "live" ? 10 :   // slightly tighter so it flips quickly at start/end
      result.state === "replay" ? 600 :
      600;

    return json(
      res,
      200,
      { ...result, generatedAt, youtubeFetchedAt },
      cacheSeconds
    );

  } catch (e) {
    // Fail "closed" (no stream) but cache a bit so you don't hot-loop errors
    return json(
      res,
      200,
      { state: "none", videoId: null, upcomingStartMs: null, generatedAt, youtubeFetchedAt: null },
      600
    );
  }
};
