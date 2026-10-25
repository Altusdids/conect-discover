import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const encoder = new TextEncoder();
const PHOTO_BUCKET = "profile-photos";
const CHAT_ATTACHMENT_BUCKET = "chat-attachments";
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_CHAT_MIME_TYPES = new Set([
  "application/pdf", "text/plain", "text/csv", "application/rtf", "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
  "video/mp4", "video/webm",
]);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_DATA_URL_CHARS = 7_100_000;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hmac(
  keyBytes: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyTelegramInitData(
  initData: string,
  botToken: string,
) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";

  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new Error("Invalid Telegram signature");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    authDate <= 0 ||
    now - authDate > 86400 ||
    authDate - now > 60
  ) {
    throw new Error("Telegram data expired; close and reopen Conect");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram Mini App's documented two-stage HMAC construction.
  const secretKey = await hmac(
    encoder.encode("WebAppData"),
    botToken,
  );
  const calculatedHash = toHex(
    await hmac(secretKey, dataCheckString),
  );

  if (!safeEqual(calculatedHash, receivedHash.toLowerCase())) {
    throw new Error("Telegram verification failed");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new Error("Telegram user data is missing");

  let user: Record<string, unknown>;
  try {
    user = JSON.parse(rawUser);
  } catch {
    throw new Error("Invalid Telegram user data");
  }

  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    throw new Error("Invalid Telegram user ID");
  }

  return user as {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    photo_url?: string;
  };
}

function getSupabaseSecretKey(): string | null {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;

  const singular = Deno.env.get("SUPABASE_SECRET_KEY");
  if (singular) return singular;

  const plural = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (plural) {
    try {
      const parsed = JSON.parse(plural);
      if (typeof parsed.default === "string" && parsed.default) {
        return parsed.default;
      }
    } catch {
      // Fall through to a safe configuration error.
    }
  }

  return null;
}

const allowedGenders = new Set([
  "Male",
  "Female",
  "Non-binary",
  "Prefer not to say",
]);

const allowedOrientations = new Set([
  "Straight",
  "Gay",
  "Lesbian",
  "Bisexual",
  "Pansexual",
  "Queer",
  "Any",
  "Other",
  "Prefer not to say",
]);

const allowedShowMe = new Set([
  "Male",
  "Female",
  "Non-binary",
  "Any",
]);

const allowedPurposes = new Set([
  "both",
  "dating",
  "friends",
]);

const allowedLookingFor = new Set([
  "younger",
  "older",
  "care_for_me",
  "care_for",
  "any",
]);

function cleanString(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

// Normalize the remaining gallery after a successful deletion or
// a failed upload reservation cleanup.
async function normalizePhotoOrder(admin: any, profileId: string) {
  const { data: photos, error } = await admin
    .from("profile_photos")
    .select("id, storage_path, sort_order, is_primary, created_at")
    .eq("user_id", profileId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Photo ordering lookup error", error.message);
    return null;
  }

  const result = [];

  for (let i = 0; i < (photos || []).length; i++) {
    const photo = photos[i];

    const { error: updateError } = await admin
      .from("profile_photos")
      .update({
        sort_order: i + 1,
        is_primary: i === 0,
      })
      .eq("id", photo.id)
      .eq("user_id", profileId);

    if (updateError) {
      console.error("Photo ordering update error", updateError.message);
      return null;
    }

    const { data: publicData } = admin.storage
      .from(PHOTO_BUCKET)
      .getPublicUrl(photo.storage_path);

    result.push({
      ...photo,
      sort_order: i + 1,
      is_primary: i === 0,
      public_url: publicData.publicUrl,
    });
  }

  return result;
}

function acceptsGender(showMe: string, targetGender: string): boolean {
  return showMe === "Any" || showMe === targetGender;
}

function purposesOverlap(a: string, b: string): boolean {
  const setA = a === "both" ? ["dating", "friends"] : [a];
  const setB = b === "both" ? ["dating", "friends"] : [b];
  return setA.some((purpose) => setB.includes(purpose));
}

function profilesAreCompatible(viewer: any, candidate: any): boolean {
  return acceptsGender(viewer.show_me, candidate.gender) &&
    acceptsGender(candidate.show_me, viewer.gender) &&
    purposesOverlap(viewer.purpose, candidate.purpose);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request" }, 400);
  }

  try {
    const initData = body.initData;

    if (typeof initData !== "string" || !initData) {
      return jsonResponse({
        error: "Telegram initData is required",
      }, 400);
    }

    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");

    if (!botToken) {
      return jsonResponse({
        error: "Telegram bot token is not configured on the server",
      }, 500);
    }

    // Every action begins by verifying Telegram's signed initData.
    const telegramUser = await verifyTelegramInitData(
      initData,
      botToken,
    );

    const action = typeof body.action === "string"
      ? body.action
      : "verify";

    if (action === "verify") {
      return jsonResponse({
        ok: true,
        telegramUser: {
          id: telegramUser.id,
          username: telegramUser.username ?? null,
          first_name: telegramUser.first_name ?? null,
          last_name: telegramUser.last_name ?? null,
          photo_url: telegramUser.photo_url ?? null,
        },
      });
    }

    if (
      action !== "load_profile" &&
      action !== "save_profile" &&
      action !== "upload_photo" &&
      action !== "delete_photo" &&
      action !== "set_primary_photo" &&
      action !== "replace_primary_photo" &&
      action !== "load_discovery" &&
      action !== "load_relationships" &&
      action !== "record_swipe" &&
      action !== "load_messages" &&
      action !== "send_message" &&
      action !== "prepare_attachment_upload" &&
      action !== "send_attachment_message" &&
      action !== "edit_message" &&
      action !== "delete_message" &&
      action !== "search_users" &&
      action !== "load_chat_updates" &&
      action !== "block_user" &&
      action !== "report_user" &&
      action !== "unblock_user" &&
      action !== "load_blocked_users" &&
      action !== "load_profile_visits" &&
      action !== "record_profile_visit" &&
      action !== "delete_account"
    ) {
      return jsonResponse({ error: "Unsupported action" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseSecretKey = getSupabaseSecretKey();

    if (!supabaseUrl || !supabaseSecretKey) {
      return jsonResponse({
        error: "Supabase server credentials are not available to this function",
      }, 500);
    }

    const admin = createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // PERMANENT ACCOUNT DELETION. The caller's profile is always resolved from
    // Telegram's verified initData; a client-supplied profile ID is never trusted.
    if (action === "delete_account") {
      const { data: account, error: accountError } = await admin
        .from("profiles")
        .select("id")
        .eq("telegram_user_id", String(telegramUser.id))
        .maybeSingle();

      if (accountError) {
        console.error("Delete account profile lookup error", accountError.message);
        return jsonResponse({ error: "Could not verify the account to delete" }, 500);
      }
      if (!account) {
        return jsonResponse({ ok: true, deleted: true, alreadyDeleted: true });
      }

      const { data: photoRows, error: photoRowsError } = await admin
        .from("profile_photos")
        .select("storage_path")
        .eq("user_id", account.id);

      if (photoRowsError) {
        console.error("Delete account photo lookup error", photoRowsError.message);
        return jsonResponse({ error: "Could not prepare account photo cleanup" }, 500);
      }

      const storagePaths = (photoRows || [])
        .map((row: any) => row.storage_path)
        .filter((path: unknown): path is string =>
          typeof path === "string" && path.length > 0
        );

      if (storagePaths.length) {
        const { error: storageDeleteError } = await admin.storage
          .from(PHOTO_BUCKET)
          .remove(storagePaths);
        if (storageDeleteError) {
          console.error("Delete account storage cleanup error", storageDeleteError.message);
          return jsonResponse({
            error: "Could not remove all account photos. Your account was not deleted; please retry.",
          }, 500);
        }
      }

      // Clean up private chat files for conversations that will be removed with this account.
      const { data: accountMatches, error: accountMatchesError } = await admin
        .from("matches")
        .select("id")
        .or(`user_a.eq.${account.id},user_b.eq.${account.id}`);
      if (accountMatchesError) {
        console.error("Delete account match lookup error", accountMatchesError.message);
        return jsonResponse({ error: "Could not prepare chat attachment cleanup" }, 500);
      }
      const accountMatchIds = (accountMatches || []).map((row: any) => row.id);
      if (accountMatchIds.length) {
        const { data: attachmentRows, error: attachmentRowsError } = await admin
          .from("messages")
          .select("attachment_path")
          .in("match_id", accountMatchIds)
          .not("attachment_path", "is", null);
        if (attachmentRowsError) {
          console.error("Delete account chat attachment lookup error", attachmentRowsError.message);
          return jsonResponse({ error: "Could not prepare chat attachment cleanup" }, 500);
        }
        const attachmentPaths = [...new Set((attachmentRows || [])
          .map((row: any) => row.attachment_path)
          .filter((path: unknown): path is string => typeof path === "string" && path.length > 0))];
        if (attachmentPaths.length) {
          const { error: attachmentCleanupError } = await admin.storage
            .from(CHAT_ATTACHMENT_BUCKET)
            .remove(attachmentPaths);
          if (attachmentCleanupError) {
            console.error("Delete account chat attachment cleanup error", attachmentCleanupError.message);
            return jsonResponse({ error: "Could not remove chat attachments. Your account was not deleted; please retry." }, 500);
          }
        }
      }

      const { data: deletionResult, error: deletionError } = await admin.rpc(
        "delete_conect_account_data",
        { p_profile_id: account.id },
      );

      if (deletionError || !deletionResult?.ok) {
        console.error("Delete account database cleanup error", deletionError?.message || "No confirmation returned");
        return jsonResponse({
          error: "Photo cleanup may have completed, but account data could not be fully deleted. Please retry or contact support.",
        }, 500);
      }

      return jsonResponse({ ok: true, deleted: true });
    }

    // REAL DISCOVERY AND SWIPES
    // Every operation identifies the caller from the verified Telegram ID,
    // never from a user ID supplied by the browser.
    if (
      action === "load_discovery" ||
      action === "load_relationships" ||
      action === "record_swipe" ||
      action === "load_messages" ||
      action === "send_message" ||
      action === "prepare_attachment_upload" ||
      action === "send_attachment_message" ||
      action === "edit_message" ||
      action === "delete_message" ||
      action === "search_users" ||
      action === "load_chat_updates" ||
      action === "block_user" ||
      action === "report_user" ||
      action === "unblock_user" ||
      action === "load_blocked_users" ||
      action === "load_profile_visits" ||
      action === "record_profile_visit"
    ) {
      const { data: viewer, error: viewerError } = await admin
        .from("profiles")
        .select("id, gender, show_me, purpose, is_active")
        .eq("telegram_user_id", String(telegramUser.id))
        .maybeSingle();

      if (viewerError) {
        console.error("Discovery viewer lookup error", viewerError.message);
        return jsonResponse({ error: "Could not verify your Conect profile" }, 500);
      }
      if (!viewer) {
        return jsonResponse({ error: "Create your Conect profile first" }, 409);
      }
      if (!viewer.is_active) {
        return jsonResponse({ error: "Your profile is not active" }, 403);
      }

      // TRUST & SAFETY: all target IDs are checked server-side and the caller is derived from verified Telegram initData.
      if (action === "block_user" || action === "unblock_user" || action === "report_user") {
        const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
          return jsonResponse({ error: "Invalid profile" }, 400);
        }
        if (targetUserId === viewer.id) {
          return jsonResponse({ error: "You cannot perform this action on your own profile" }, 400);
        }

        const { data: targetProfile, error: targetError } = await admin
          .from("profiles")
          .select("id")
          .eq("id", targetUserId)
          .maybeSingle();

        if (targetError) {
          console.error("Trust and safety target lookup error", targetError.message);
          return jsonResponse({ error: "Could not verify this profile" }, 500);
        }
        if (!targetProfile) {
          return jsonResponse({ error: "This profile is no longer available" }, 404);
        }

        if (action === "unblock_user") {
          const { error: unblockError } = await admin
            .from("blocks")
            .delete()
            .eq("blocker_user_id", viewer.id)
            .eq("blocked_user_id", targetUserId);

          if (unblockError) {
            console.error("Unblock profile error", unblockError.message);
            return jsonResponse({ error: "Could not unblock this profile" }, 500);
          }

          return jsonResponse({ ok: true, unblockedUserId: targetUserId });
        }

        if (action === "block_user") {
          const { error: blockInsertError } = await admin
            .from("blocks")
            .upsert(
              { blocker_user_id: viewer.id, blocked_user_id: targetUserId },
              { onConflict: "blocker_user_id,blocked_user_id", ignoreDuplicates: true }
            );

          if (blockInsertError) {
            console.error("Block profile insert error", blockInsertError.message);
            return jsonResponse({ error: "Could not block this profile" }, 500);
          }

          return jsonResponse({ ok: true, blockedUserId: targetUserId });
        }

        const allowedReasons = new Set([
          "fake_profile",
          "harassment",
          "spam",
          "inappropriate_content",
          "underage_suspicion",
          "other",
        ]);
        const reason = typeof body.reason === "string" ? body.reason : "";
        const details = typeof body.details === "string" ? body.details.trim().slice(0, 2000) : "";
        if (!allowedReasons.has(reason)) {
          return jsonResponse({ error: "Choose a valid report reason" }, 400);
        }

        const { data: report, error: reportError } = await admin
          .from("reports")
          .insert({
            reporter_user_id: viewer.id,
            reported_user_id: targetUserId,
            reason,
            details,
          })
          .select("id, status, created_at")
          .single();

        if (reportError || !report) {
          console.error("Report profile insert error", reportError?.message);
          return jsonResponse({ error: "Could not submit this report" }, 500);
        }

        return jsonResponse({ ok: true, report: { id: report.id, status: report.status, created_at: report.created_at } });
      }

      // PROFILE VISITS: record the latest visit once per visitor/profile pair.
      if (action === "record_profile_visit") {
        const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
          return jsonResponse({ error: "Invalid profile" }, 400);
        }
        if (targetUserId === viewer.id) return jsonResponse({ ok: true, skipped: true });

        const { data: target, error: targetError } = await admin
          .from("profiles")
          .select("id, is_active")
          .eq("id", targetUserId)
          .maybeSingle();
        if (targetError) {
          console.error("Profile visit target lookup error", targetError.message);
          return jsonResponse({ error: "Could not verify this profile" }, 500);
        }
        if (!target || !target.is_active) return jsonResponse({ ok: true, skipped: true });

        const blockedOr = "and(blocker_user_id.eq." + viewer.id + ",blocked_user_id.eq." + targetUserId + "),and(blocker_user_id.eq." + targetUserId + ",blocked_user_id.eq." + viewer.id + ")";
        const { data: blockedRows, error: blockedError } = await admin
          .from("blocks")
          .select("blocker_user_id, blocked_user_id")
          .or(blockedOr);
        if (blockedError) {
          console.error("Profile visit block lookup error", blockedError.message);
          return jsonResponse({ error: "Could not verify profile visibility" }, 500);
        }
        if ((blockedRows || []).length) return jsonResponse({ ok: true, skipped: true });

        const retentionCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const { error: cleanupError } = await admin
          .from("profile_visits")
          .delete()
          .lt("last_visited_at", retentionCutoff);
        if (cleanupError) {
          console.error("Old profile visit cleanup error", cleanupError.message);
          return jsonResponse({ error: "Could not record profile visit" }, 500);
        }

        const { error: visitError } = await admin
          .from("profile_visits")
          .upsert({ visitor_user_id: viewer.id, visited_user_id: targetUserId, last_visited_at: new Date().toISOString() }, { onConflict: "visitor_user_id,visited_user_id" });
        if (visitError) {
          console.error("Profile visit upsert error", visitError.message);
          return jsonResponse({ error: "Could not record profile visit" }, 500);
        }
        return jsonResponse({ ok: true, recorded: true });
      }

      // Only show visits from the last 72 hours by people the profile owner has liked.
      if (action === "load_profile_visits") {
        const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const visitsResult = await admin.from("profile_visits")
          .select("visitor_user_id, last_visited_at")
          .eq("visited_user_id", viewer.id)
          .gte("last_visited_at", cutoff)
          .order("last_visited_at", { ascending: false })
          .limit(200);
        if (visitsResult.error) {
          console.error("Profile visits lookup error", visitsResult.error.message);
          return jsonResponse({ error: "Could not load profile visits" }, 500);
        }
        const visitRows = visitsResult.data || [];
        const visitorIds = [...new Set<string>(visitRows.map((row: any) => row.visitor_user_id))];
        if (!visitorIds.length) return jsonResponse({ ok: true, visits: [], count: 0 });

        const [likedResult, blockedByViewerResult, blockedViewerResult] = await Promise.all([
          admin.from("swipes").select("to_user_id").eq("from_user_id", viewer.id).in("to_user_id", visitorIds).in("action", ["like", "super_like"]),
          admin.from("blocks").select("blocked_user_id").eq("blocker_user_id", viewer.id),
          admin.from("blocks").select("blocker_user_id").eq("blocked_user_id", viewer.id),
        ]);
        if (likedResult.error || blockedByViewerResult.error || blockedViewerResult.error) {
          console.error("Profile visits privacy filter error", { likes: likedResult.error?.message, blockedByViewer: blockedByViewerResult.error?.message, blockedViewer: blockedViewerResult.error?.message });
          return jsonResponse({ error: "Could not load profile visits" }, 500);
        }
        const likedIds = new Set<string>((likedResult.data || []).map((row: any) => row.to_user_id));
        const blockedIds = new Set<string>([
          ...(blockedByViewerResult.data || []).map((row: any) => row.blocked_user_id),
          ...(blockedViewerResult.data || []).map((row: any) => row.blocker_user_id),
        ]);
        const eligibleRows = visitRows.filter((row: any) => likedIds.has(row.visitor_user_id) && !blockedIds.has(row.visitor_user_id));
        const eligibleIds = [...new Set<string>(eligibleRows.map((row: any) => row.visitor_user_id))];
        if (!eligibleIds.length) return jsonResponse({ ok: true, visits: [], count: 0 });

        const [profilesResult, photosResult, interestsResult] = await Promise.all([
          admin.from("profiles").select("id, app_username, display_name, age, gender, country, city, bio, purpose, is_active").in("id", eligibleIds).eq("is_active", true),
          admin.from("profile_photos").select("user_id, storage_path, sort_order, is_primary").in("user_id", eligibleIds).order("sort_order", { ascending: true }),
          admin.from("profile_interests").select("user_id, interest, position").in("user_id", eligibleIds).order("position", { ascending: true }),
        ]);
        if (profilesResult.error || photosResult.error || interestsResult.error) {
          console.error("Profile visits profile detail error", { profiles: profilesResult.error?.message, photos: photosResult.error?.message, interests: interestsResult.error?.message });
          return jsonResponse({ error: "Could not load profile visits" }, 500);
        }
        const photosByUser = new Map<string, any[]>();
        for (const row of photosResult.data || []) {
          const existing = photosByUser.get(row.user_id) || [];
          existing.push({ public_url: admin.storage.from(PHOTO_BUCKET).getPublicUrl(row.storage_path).data.publicUrl, sort_order: row.sort_order, is_primary: row.is_primary });
          photosByUser.set(row.user_id, existing);
        }
        const interestsByUser = new Map<string, string[]>();
        for (const row of interestsResult.data || []) {
          const existing = interestsByUser.get(row.user_id) || []; existing.push(row.interest); interestsByUser.set(row.user_id, existing);
        }
        const profileById = new Map<string, any>();
        for (const profile of profilesResult.data || []) {
          const photos = photosByUser.get(profile.id) || [];
          const primary = photos.find((photo: any) => photo.is_primary) || photos[0] || null;
          profileById.set(profile.id, { id: profile.id, username: profile.app_username, name: profile.display_name, age: profile.age, gender: profile.gender, location: [profile.city, profile.country].filter(Boolean).join(", "), bio: profile.bio, purpose: profile.purpose, interests: interestsByUser.get(profile.id) || [], photos, photo: primary?.public_url || null });
        }
        const visits = eligibleRows.filter((row: any) => profileById.has(row.visitor_user_id)).map((row: any) => ({ ...profileById.get(row.visitor_user_id), last_visited_at: row.last_visited_at }));
        return jsonResponse({ ok: true, visits, count: visits.length, window_hours: 72 });
      }

      // List users blocked by the verified viewer; emails are never returned here.
      if (action === "load_blocked_users") {
        const blocksResult = await admin.from("blocks").select("blocked_user_id, created_at").eq("blocker_user_id", viewer.id).order("created_at", { ascending: false });
        if (blocksResult.error) { console.error("Blocked users lookup error", blocksResult.error.message); return jsonResponse({ error: "Could not load blocked users" }, 500); }
        const blockedIds = [...new Set<string>((blocksResult.data || []).map((row: any) => row.blocked_user_id))];
        if (!blockedIds.length) return jsonResponse({ ok: true, blockedUsers: [] });
        const [profilesResult, photosResult] = await Promise.all([
          admin.from("profiles").select("id, app_username, display_name, age, gender, country, city, bio, purpose, is_active").in("id", blockedIds),
          admin.from("profile_photos").select("user_id, storage_path, sort_order, is_primary").in("user_id", blockedIds).order("sort_order", { ascending: true }),
        ]);
        if (profilesResult.error || photosResult.error) { console.error("Blocked user profile lookup error", { profiles: profilesResult.error?.message, photos: photosResult.error?.message }); return jsonResponse({ error: "Could not load blocked users" }, 500); }
        const photosByUser = new Map<string, any[]>();
        for (const row of photosResult.data || []) { const existing = photosByUser.get(row.user_id) || []; existing.push({ public_url: admin.storage.from(PHOTO_BUCKET).getPublicUrl(row.storage_path).data.publicUrl, sort_order: row.sort_order, is_primary: row.is_primary }); photosByUser.set(row.user_id, existing); }
        const blockedUsers = (profilesResult.data || []).map((profile: any) => { const photos = photosByUser.get(profile.id) || []; const primary = photos.find((photo: any) => photo.is_primary) || photos[0] || null; return { id: profile.id, username: profile.app_username, name: profile.display_name, age: profile.age, gender: profile.gender, location: [profile.city, profile.country].filter(Boolean).join(", "), bio: profile.bio, purpose: profile.purpose, interests: [], photos, photo: primary?.public_url || null }; });
        return jsonResponse({ ok: true, blockedUsers });
      }

      // CHAT INBOX UPDATES: returns unread counts and latest previews without marking messages read.
      if (action === "load_chat_updates") {
        const [matchesResult, blockedByViewerResult, blockedViewerResult] = await Promise.all([
          admin
            .from("matches")
            .select("id, user_a, user_b, created_at")
            .or(`user_a.eq.${viewer.id},user_b.eq.${viewer.id}`)
            .order("created_at", { ascending: false }),
          admin
            .from("blocks")
            .select("blocked_user_id")
            .eq("blocker_user_id", viewer.id),
          admin
            .from("blocks")
            .select("blocker_user_id")
            .eq("blocked_user_id", viewer.id),
        ]);

        if (matchesResult.error || blockedByViewerResult.error || blockedViewerResult.error) {
          console.error("Chat inbox lookup error", {
            matches: matchesResult.error?.message,
            blockedByViewer: blockedByViewerResult.error?.message,
            blockedViewer: blockedViewerResult.error?.message,
          });
          return jsonResponse({ error: "Could not load chat updates" }, 500);
        }

        const blockedIds = new Set<string>([
          ...(blockedByViewerResult.data || []).map((row: any) => row.blocked_user_id),
          ...(blockedViewerResult.data || []).map((row: any) => row.blocker_user_id),
        ]);
        const matchRows = (matchesResult.data || []).filter((row: any) => {
          const peerId = row.user_a === viewer.id ? row.user_b : row.user_a;
          return !blockedIds.has(peerId);
        });
        const matchIds = matchRows.map((row: any) => row.id);
        const messageResult = matchIds.length
          ? await admin
              .from("messages")
              .select("id, match_id, sender_user_id, body, created_at, read_at, message_type, attachment_name")
              .in("match_id", matchIds)
              .order("created_at", { ascending: false })
              .limit(1000)
          : { data: [], error: null };

        if (messageResult.error) {
          console.error("Chat inbox message lookup error", messageResult.error.message);
          return jsonResponse({ error: "Could not load chat updates" }, 500);
        }

        const updatesByMatch = new Map<string, any>();
        for (const row of matchRows) {
          updatesByMatch.set(row.id, {
            match_id: row.id,
            created_at: row.created_at,
            latest: null,
            unread_count: 0,
          });
        }
        for (const message of messageResult.data || []) {
          const update = updatesByMatch.get(message.match_id);
          if (!update) continue;
          if (!update.latest) {
            update.latest = {
              body: message.body,
              message_type: message.message_type || "text",
              attachment_name: message.attachment_name || null,
              sender_user_id: message.sender_user_id,
              created_at: message.created_at,
              is_mine: message.sender_user_id === viewer.id,
            };
          }
          if (message.sender_user_id !== viewer.id && !message.read_at) {
            update.unread_count += 1;
          }
        }

        return jsonResponse({
          ok: true,
          updates: matchRows.map((row: any) => updatesByMatch.get(row.id)),
        });
      }

      // PRIVATE MESSAGING: only participants in a real, active match can read/send/edit/delete.
      if (action === "load_messages" || action === "send_message" || action === "prepare_attachment_upload" || action === "send_attachment_message" || action === "edit_message" || action === "delete_message") {
        const matchId = typeof body.matchId === "string" ? body.matchId.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(matchId)) {
          return jsonResponse({ error: "Invalid conversation" }, 400);
        }

        const { data: matchRow, error: matchError } = await admin
          .from("matches")
          .select("id, user_a, user_b")
          .eq("id", matchId)
          .maybeSingle();

        if (matchError) {
          console.error("Message match lookup error", matchError.message);
          return jsonResponse({ error: "Could not verify this conversation" }, 500);
        }
        if (!matchRow || (matchRow.user_a !== viewer.id && matchRow.user_b !== viewer.id)) {
          return jsonResponse({ error: "Conversation not found" }, 404);
        }

        const peerId = matchRow.user_a === viewer.id ? matchRow.user_b : matchRow.user_a;
        const { data: blockRows, error: blockError } = await admin
          .from("blocks")
          .select("blocker_user_id, blocked_user_id")
          .or(`and(blocker_user_id.eq.${viewer.id},blocked_user_id.eq.${peerId}),and(blocker_user_id.eq.${peerId},blocked_user_id.eq.${viewer.id})`);

        if (blockError) {
          console.error("Message block check error", blockError.message);
          return jsonResponse({ error: "Could not verify conversation access" }, 500);
        }
        if ((blockRows || []).length) {
          return jsonResponse({ error: "Messaging is unavailable for this conversation" }, 403);
        }

        if (action === "prepare_attachment_upload") {
          const rawFileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
          const rawMimeType = typeof body.mimeType === "string" ? body.mimeType.split(";")[0].trim().toLowerCase() : "";
          const rawFileSize = Number(body.fileSize);
          const messageType = body.messageType === "voice" ? "voice" : "file";
          if (!rawFileName || rawFileName.length > 180) {
            return jsonResponse({ error: "Choose a file with a valid filename" }, 400);
          }
          if (!ALLOWED_CHAT_MIME_TYPES.has(rawMimeType)) {
            return jsonResponse({ error: "This file type is not supported" }, 415);
          }
          if (messageType === "voice" && !rawMimeType.startsWith("audio/")) {
            return jsonResponse({ error: "A voice message must be an audio file" }, 400);
          }
          if (!Number.isInteger(rawFileSize) || rawFileSize < 1 || rawFileSize > MAX_CHAT_ATTACHMENT_BYTES) {
            return jsonResponse({ error: "Files and voice messages must be 10 MB or smaller" }, 413);
          }
          const safeFileName = rawFileName
            .replace(/[^a-zA-Z0-9._ ()-]/g, "_")
            .replace(/\.{2,}/g, ".")
            .slice(0, 120) || (messageType === "voice" ? "voice-message" : "attachment");
          const storagePath = matchRow.id + "/" + viewer.id + "/" + crypto.randomUUID() + "-" + safeFileName;
          const { data: signedUpload, error: signedUploadError } = await admin.storage
            .from(CHAT_ATTACHMENT_BUCKET)
            .createSignedUploadUrl(storagePath);
          if (signedUploadError || !signedUpload) {
            console.error("Chat attachment signed upload URL error", signedUploadError?.message);
            return jsonResponse({ error: "Could not prepare the file upload" }, 500);
          }
          return jsonResponse({
            ok: true,
            storagePath,
            signedUploadUrl: signedUpload.signedUrl,
            fileName: safeFileName,
            mimeType: rawMimeType,
            fileSize: rawFileSize,
            messageType,
          });
        }

        if (action === "send_attachment_message") {
          const storagePath = typeof body.storagePath === "string" ? body.storagePath.trim() : "";
          const rawFileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
          const rawMimeType = typeof body.mimeType === "string" ? body.mimeType.split(";")[0].trim().toLowerCase() : "";
          const rawFileSize = Number(body.fileSize);
          const messageType = body.messageType === "voice" ? "voice" : "file";
          const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 2000) : "";
          const prefix = matchRow.id + "/" + viewer.id + "/";
          if (!storagePath.startsWith(prefix) || storagePath.slice(prefix.length).includes("/") ||
              storagePath.slice(prefix.length).includes("..")) {
            return jsonResponse({ error: "Invalid attachment path" }, 400);
          }
          if (!rawFileName || rawFileName.length > 180 || !ALLOWED_CHAT_MIME_TYPES.has(rawMimeType)) {
            return jsonResponse({ error: "Invalid attachment details" }, 400);
          }
          if (messageType === "voice" && !rawMimeType.startsWith("audio/")) {
            return jsonResponse({ error: "A voice message must be an audio file" }, 400);
          }
          if (!Number.isInteger(rawFileSize) || rawFileSize < 1 || rawFileSize > MAX_CHAT_ATTACHMENT_BYTES) {
            return jsonResponse({ error: "Files and voice messages must be 10 MB or smaller" }, 413);
          }
          const safeFileName = rawFileName
            .replace(/[^a-zA-Z0-9._ ()-]/g, "_")
            .replace(/\.{2,}/g, ".")
            .slice(0, 120) || (messageType === "voice" ? "voice-message" : "attachment");
          const storedName = storagePath.slice(prefix.length);
          if (!storedName.endsWith("-" + safeFileName)) {
            return jsonResponse({ error: "Attachment filename does not match the uploaded file" }, 400);
          }

          const { data: storedObjects, error: listError } = await admin.storage
            .from(CHAT_ATTACHMENT_BUCKET)
            .list(matchRow.id + "/" + viewer.id, { limit: 100, search: storedName });
          if (listError) {
            console.error("Chat attachment verification error", listError.message);
            return jsonResponse({ error: "Could not verify the uploaded file" }, 500);
          }
          const storedObject = (storedObjects || []).find((object: any) => object.name === storedName);
          if (!storedObject || !storedObject.metadata) {
            return jsonResponse({ error: "Upload was not found. Please retry the attachment." }, 409);
          }
          const storedSize = Number(storedObject.metadata.size ?? storedObject.metadata.contentLength);
          const storedMime = String(storedObject.metadata.mimetype || storedObject.metadata.contentType || "").split(";")[0].toLowerCase();
          if (!Number.isFinite(storedSize) || storedSize !== rawFileSize || storedSize > MAX_CHAT_ATTACHMENT_BYTES) {
            return jsonResponse({ error: "The uploaded file size did not match. Please try again." }, 400);
          }
          if (storedMime && storedMime !== rawMimeType) {
            return jsonResponse({ error: "The uploaded file type did not match. Please try again." }, 400);
          }

          const rawReplyTo = typeof body.replyToMessageId === "string" ? body.replyToMessageId.trim() : "";
          if (rawReplyTo && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawReplyTo)) {
            return jsonResponse({ error: "Invalid reply message" }, 400);
          }
          let replyToMessageId: string | null = null;
          if (rawReplyTo) {
            const { data: replyMessage, error: replyLookupError } = await admin
              .from("messages")
              .select("id")
              .eq("id", rawReplyTo)
              .eq("match_id", matchRow.id)
              .maybeSingle();
            if (replyLookupError) {
              console.error("Attachment reply lookup error", replyLookupError.message);
              return jsonResponse({ error: "Could not verify reply message" }, 500);
            }
            if (!replyMessage) return jsonResponse({ error: "The replied-to message is no longer available" }, 400);
            replyToMessageId = replyMessage.id;
          }

          const { data: newMessage, error: insertError } = await admin
            .from("messages")
            .insert({
              match_id: matchRow.id,
              sender_user_id: viewer.id,
              body: caption,
              message_type: messageType,
              attachment_path: storagePath,
              attachment_name: safeFileName,
              attachment_mime_type: rawMimeType,
              attachment_size: storedSize,
              reply_to_message_id: replyToMessageId,
            })
            .select("id, match_id, sender_user_id, body, created_at, read_at, reply_to_message_id, edited_at, message_type, attachment_path, attachment_name, attachment_mime_type, attachment_size")
            .single();

          if (insertError || !newMessage) {
            console.error("Chat attachment message insert error", insertError?.message);
            const { error: cleanupError } = await admin.storage.from(CHAT_ATTACHMENT_BUCKET).remove([storagePath]);
            if (cleanupError) console.error("Chat attachment rollback cleanup error", cleanupError.message);
            return jsonResponse({ error: "The file uploaded but could not be added to the conversation" }, 500);
          }

          const { data: signed, error: signedError } = await admin.storage
            .from(CHAT_ATTACHMENT_BUCKET)
            .createSignedUrl(storagePath, 3600);
          if (signedError) console.warn("Chat attachment signed URL error", signedError.message);
          return jsonResponse({
            ok: true,
            message: { ...newMessage, attachment_url: signed?.signedUrl || null, is_mine: true },
          });
        }

        if (action === "edit_message") {
          const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
          const messageBody = typeof body.message === "string" ? body.message.trim() : "";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
            return jsonResponse({ error: "Invalid message" }, 400);
          }
          if (!messageBody || messageBody.length > 4000) {
            return jsonResponse({ error: "Messages must contain 1–4000 characters" }, 400);
          }
          const { data: ownMessage, error: ownMessageError } = await admin
            .from("messages")
            .select("id, sender_user_id")
            .eq("id", messageId)
            .eq("match_id", matchRow.id)
            .maybeSingle();
          if (ownMessageError) {
            console.error("Edit message lookup error", ownMessageError.message);
            return jsonResponse({ error: "Could not verify that message" }, 500);
          }
          if (!ownMessage || ownMessage.sender_user_id !== viewer.id) {
            return jsonResponse({ error: "You can only edit your own messages" }, 403);
          }
          const { data: updatedMessage, error: editError } = await admin
            .from("messages")
            .update({ body: messageBody, edited_at: new Date().toISOString() })
            .eq("id", messageId)
            .eq("match_id", matchRow.id)
            .eq("sender_user_id", viewer.id)
            .select("id, match_id, sender_user_id, body, created_at, read_at, reply_to_message_id, edited_at")
            .maybeSingle();
          if (editError || !updatedMessage) {
            console.error("Edit message database error", editError?.message || "Message not found");
            return jsonResponse({ error: "Could not edit message" }, 500);
          }
          return jsonResponse({ ok: true, message: { ...updatedMessage, is_mine: true } });
        }

        if (action === "delete_message") {
          const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
            return jsonResponse({ error: "Invalid message" }, 400);
          }
          const { data: ownMessage, error: ownMessageError } = await admin
            .from("messages")
            .select("id, sender_user_id, attachment_path")
            .eq("id", messageId)
            .eq("match_id", matchRow.id)
            .maybeSingle();
          if (ownMessageError) {
            console.error("Delete message lookup error", ownMessageError.message);
            return jsonResponse({ error: "Could not verify that message" }, 500);
          }
          if (!ownMessage || ownMessage.sender_user_id !== viewer.id) {
            return jsonResponse({ error: "You can only delete your own messages" }, 403);
          }
          const { error: deleteError } = await admin
            .from("messages")
            .delete()
            .eq("id", messageId)
            .eq("match_id", matchRow.id)
            .eq("sender_user_id", viewer.id);
          if (deleteError) {
            console.error("Delete message database error", deleteError.message);
            return jsonResponse({ error: "Could not delete message" }, 500);
          }
          if (ownMessage.attachment_path) {
            const { error: storageError } = await admin.storage
              .from(CHAT_ATTACHMENT_BUCKET)
              .remove([ownMessage.attachment_path]);
            if (storageError) console.error("Deleted chat message attachment cleanup error", storageError.message);
          }
          return jsonResponse({ ok: true, deleted: true, messageId });
        }

        if (action === "send_message") {
          const messageBody = typeof body.message === "string" ? body.message.trim() : "";
          if (!messageBody || messageBody.length > 4000) {
            return jsonResponse({ error: "Messages must contain 1–4000 characters" }, 400);
          }
          const rawReplyTo = typeof body.replyToMessageId === "string" ? body.replyToMessageId.trim() : "";
          if (rawReplyTo && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawReplyTo)) {
            return jsonResponse({ error: "Invalid reply message" }, 400);
          }
          let replyToMessageId: string | null = null;
          if (rawReplyTo) {
            const { data: replyMessage, error: replyLookupError } = await admin
              .from("messages")
              .select("id")
              .eq("id", rawReplyTo)
              .eq("match_id", matchRow.id)
              .maybeSingle();
            if (replyLookupError) {
              console.error("Reply lookup error", replyLookupError.message);
              return jsonResponse({ error: "Could not verify reply message" }, 500);
            }
            if (!replyMessage) return jsonResponse({ error: "The replied-to message is no longer available" }, 400);
            replyToMessageId = replyMessage.id;
          }

          const { data: newMessage, error: insertError } = await admin
            .from("messages")
            .insert({
              match_id: matchRow.id,
              sender_user_id: viewer.id,
              body: messageBody,
              reply_to_message_id: replyToMessageId,
            })
            .select("id, match_id, sender_user_id, body, created_at, read_at, reply_to_message_id, edited_at")
            .single();

          if (insertError || !newMessage) {
            console.error("Message insert error", insertError?.message);
            return jsonResponse({ error: "Could not send your message" }, 500);
          }

          return jsonResponse({
            ok: true,
            message: { ...newMessage, is_mine: true },
          });
        }

        const { error: markReadError } = await admin
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("match_id", matchRow.id)
          .neq("sender_user_id", viewer.id)
          .is("read_at", null);

        if (markReadError) {
          console.error("Message read-state update error", markReadError.message);
          return jsonResponse({ error: "Could not load conversation messages" }, 500);
        }

        const { data: messageRows, error: messagesError } = await admin
          .from("messages")
          .select("id, match_id, sender_user_id, body, created_at, read_at, reply_to_message_id, edited_at, message_type, attachment_path, attachment_name, attachment_mime_type, attachment_size")
          .eq("match_id", matchRow.id)
          .order("created_at", { ascending: true })
          .limit(200);

        if (messagesError) {
          console.error("Message history query error", messagesError.message);
          return jsonResponse({ error: "Could not load conversation messages" }, 500);
        }

        const messageBodiesById = new Map((messageRows || []).map((message: any) => [message.id, message.body]));
        const messagesWithSignedAttachments = await Promise.all((messageRows || []).map(async (message: any) => {
          let attachment_url: string | null = null;
          if (message.attachment_path) {
            const { data: signed, error: signedError } = await admin.storage
              .from(CHAT_ATTACHMENT_BUCKET)
              .createSignedUrl(message.attachment_path, 3600);
            if (signedError) console.warn("Chat attachment signed URL error", signedError.message);
            attachment_url = signed?.signedUrl || null;
          }
          return {
            ...message,
            attachment_url,
            reply_to_body: message.reply_to_message_id ? messageBodiesById.get(message.reply_to_message_id) || "" : null,
            is_mine: message.sender_user_id === viewer.id,
          };
        }));
        return jsonResponse({ ok: true, messages: messagesWithSignedAttachments });
      }

      if (action === "load_relationships") {
        const [
          outgoingResult,
          incomingResult,
          matchesResult,
          blockedByViewerResult,
          blockedViewerResult,
        ] = await Promise.all([
          admin
            .from("swipes")
            .select("to_user_id, action, created_at")
            .eq("from_user_id", viewer.id)
            .in("action", ["like", "super_like"]),
          admin
            .from("swipes")
            .select("from_user_id, action, created_at")
            .eq("to_user_id", viewer.id)
            .in("action", ["like", "super_like"]),
          admin
            .from("matches")
            .select("id, user_a, user_b, created_at")
            .or(`user_a.eq.${viewer.id},user_b.eq.${viewer.id}`)
            .order("created_at", { ascending: false }),
          admin
            .from("blocks")
            .select("blocked_user_id")
            .eq("blocker_user_id", viewer.id),
          admin
            .from("blocks")
            .select("blocker_user_id")
            .eq("blocked_user_id", viewer.id),
        ]);

        if (
          outgoingResult.error || incomingResult.error || matchesResult.error ||
          blockedByViewerResult.error || blockedViewerResult.error
        ) {
          console.error("Relationship lookup error", {
            outgoing: outgoingResult.error?.message,
            incoming: incomingResult.error?.message,
            matches: matchesResult.error?.message,
            blockedByViewer: blockedByViewerResult.error?.message,
            blockedViewer: blockedViewerResult.error?.message,
          });
          return jsonResponse({ error: "Could not load your likes and matches" }, 500);
        }

        const blockedIds = new Set<string>([
          ...(blockedByViewerResult.data || []).map((row: any) => row.blocked_user_id),
          ...(blockedViewerResult.data || []).map((row: any) => row.blocker_user_id),
        ]);
        const likedIds = [...new Set<string>(
          (outgoingResult.data || [])
            .map((row: any) => row.to_user_id)
            .filter((id: string) => !blockedIds.has(id)),
        )];
        const incomingIds = [...new Set<string>(
          (incomingResult.data || [])
            .map((row: any) => row.from_user_id)
            .filter((id: string) => !blockedIds.has(id)),
        )];
        const matchRows = (matchesResult.data || []).filter((row: any) => {
          const peerId = row.user_a === viewer.id ? row.user_b : row.user_a;
          return !blockedIds.has(peerId);
        });
        const matchPeerIds = matchRows.map((row: any) =>
          row.user_a === viewer.id ? row.user_b : row.user_a
        );
        const allIds = [...new Set<string>([
          ...likedIds,
          ...incomingIds,
          ...matchPeerIds,
        ])];

        const cardsById = new Map<string, any>();
        if (allIds.length) {
          const [profilesResult, photosResult, interestsResult] = await Promise.all([
            admin
              .from("profiles")
              .select("id, app_username, display_name, age, gender, country, city, bio, purpose, show_me, is_active")
              .in("id", allIds)
              .eq("is_active", true),
            admin
              .from("profile_photos")
              .select("user_id, storage_path, sort_order, is_primary")
              .in("user_id", allIds)
              .order("sort_order", { ascending: true }),
            admin
              .from("profile_interests")
              .select("user_id, interest, position")
              .in("user_id", allIds)
              .order("position", { ascending: true }),
          ]);

          if (profilesResult.error || photosResult.error || interestsResult.error) {
            console.error("Relationship profile details error", {
              profiles: profilesResult.error?.message,
              photos: photosResult.error?.message,
              interests: interestsResult.error?.message,
            });
            return jsonResponse({ error: "Could not load relationship profile details" }, 500);
          }

          const photosByUser = new Map<string, any[]>();
          for (const photo of photosResult.data || []) {
            const photos = photosByUser.get(photo.user_id) || [];
            photos.push({
              public_url: admin.storage
                .from(PHOTO_BUCKET)
                .getPublicUrl(photo.storage_path).data.publicUrl,
              sort_order: photo.sort_order,
              is_primary: photo.is_primary,
            });
            photosByUser.set(photo.user_id, photos);
          }
          const interestsByUser = new Map<string, string[]>();
          for (const row of interestsResult.data || []) {
            const interests = interestsByUser.get(row.user_id) || [];
            interests.push(row.interest);
            interestsByUser.set(row.user_id, interests);
          }

          for (const profile of profilesResult.data || []) {
            const photos = photosByUser.get(profile.id) || [];
            const primary = photos.find((photo: any) => photo.is_primary) || photos[0] || null;
            cardsById.set(profile.id, {
              id: profile.id,
              username: profile.app_username,
              name: profile.display_name,
              age: profile.age,
              gender: profile.gender,
              location: [profile.city, profile.country].filter(Boolean).join(", "),
              bio: profile.bio,
              purpose: profile.purpose,
              interests: interestsByUser.get(profile.id) || [],
              photos,
              photo: primary?.public_url || null,
            });
          }
        }

        const likedProfiles = likedIds
          .map((id) => cardsById.get(id))
          .filter(Boolean);
        const incomingLikes = incomingIds
          .map((id) => cardsById.get(id))
          .filter(Boolean);
        const matches = matchRows
          .map((row: any) => {
            const peerId = row.user_a === viewer.id ? row.user_b : row.user_a;
            const profile = cardsById.get(peerId);
            return profile ? {
              id: row.id,
              created_at: row.created_at,
              profile,
            } : null;
          })
          .filter(Boolean);

        return jsonResponse({
          ok: true,
          likedProfiles,
          incomingLikes,
          matches,
        });
      }

      if (action === "search_users") {
        const query = typeof body.query === "string"
          ? body.query.trim().replace(/^@+/, "").toLowerCase()
          : "";
        if (!/^[a-z0-9_]{3,20}$/.test(query)) {
          return jsonResponse({ error: "Enter a username prefix with 3–20 letters, numbers, or underscores" }, 400);
        }

        const [profilesResult, blocksOutResult, blocksInResult] = await Promise.all([
          admin.from("profiles")
            .select("id, app_username, display_name, age, gender, country, city, bio, purpose, looking_for, is_active")
            .eq("is_active", true)
            .neq("id", viewer.id)
            .ilike("app_username", query + "%")
            .order("app_username", { ascending: true })
            .limit(25),
          admin.from("blocks").select("blocked_user_id").eq("blocker_user_id", viewer.id),
          admin.from("blocks").select("blocker_user_id").eq("blocked_user_id", viewer.id),
        ]);

        if (profilesResult.error || blocksOutResult.error || blocksInResult.error) {
          console.error("Username search error", {
            profiles: profilesResult.error?.message,
            blocksOut: blocksOutResult.error?.message,
            blocksIn: blocksInResult.error?.message,
          });
          return jsonResponse({ error: "Could not search Conect usernames" }, 500);
        }

        const blockedIds = new Set([
          ...(blocksOutResult.data || []).map((row: any) => row.blocked_user_id),
          ...(blocksInResult.data || []).map((row: any) => row.blocker_user_id),
        ]);
        const candidates = (profilesResult.data || [])
          .filter((profile: any) => !blockedIds.has(profile.id))
          .slice(0, 20);
        if (!candidates.length) return jsonResponse({ ok: true, profiles: [] });

        const candidateIds = candidates.map((profile: any) => profile.id);
        const [photosResult, interestsResult] = await Promise.all([
          admin.from("profile_photos")
            .select("user_id, storage_path, sort_order, is_primary")
            .in("user_id", candidateIds)
            .order("sort_order", { ascending: true }),
          admin.from("profile_interests")
            .select("user_id, interest, position")
            .in("user_id", candidateIds)
            .order("position", { ascending: true }),
        ]);
        if (photosResult.error || interestsResult.error) {
          console.error("Username search profile details error", {
            photos: photosResult.error?.message,
            interests: interestsResult.error?.message,
          });
          return jsonResponse({ error: "Could not load profile search results" }, 500);
        }

        const photosByUser = new Map<string, any[]>();
        for (const photo of photosResult.data || []) {
          const list = photosByUser.get(photo.user_id) || [];
          list.push({
            public_url: admin.storage.from(PHOTO_BUCKET).getPublicUrl(photo.storage_path).data.publicUrl,
            sort_order: photo.sort_order,
            is_primary: photo.is_primary,
          });
          photosByUser.set(photo.user_id, list);
        }
        const interestsByUser = new Map<string, string[]>();
        for (const row of interestsResult.data || []) {
          const list = interestsByUser.get(row.user_id) || [];
          list.push(row.interest);
          interestsByUser.set(row.user_id, list);
        }

        const safeProfiles = candidates.map((profile: any) => {
          const photos = photosByUser.get(profile.id) || [];
          const primary = photos.find((photo: any) => photo.is_primary) || photos[0] || null;
          return {
            id: profile.id,
            username: profile.app_username,
            name: profile.display_name,
            age: profile.age,
            gender: profile.gender,
            location: [profile.city, profile.country].filter(Boolean).join(", "),
            bio: profile.bio,
            purpose: profile.purpose,
            looking_for: profile.looking_for || "any",
            interests: interestsByUser.get(profile.id) || [],
            photos,
            photo: primary?.public_url || null,
          };
        });
        return jsonResponse({ ok: true, profiles: safeProfiles });
      }

      if (action === "load_discovery") {
        const [profilesResult, swipesResult, blocksOutResult, blocksInResult] =
          await Promise.all([
            admin
              .from("profiles")
              .select("id, app_username, display_name, age, gender, country, city, bio, purpose, show_me, looking_for, is_active, created_at")
              .eq("is_active", true)
              .neq("id", viewer.id)
              .order("created_at", { ascending: false })
              .limit(200),
            admin.from("swipes").select("to_user_id").eq("from_user_id", viewer.id),
            admin.from("blocks").select("blocked_user_id").eq("blocker_user_id", viewer.id),
            admin.from("blocks").select("blocker_user_id").eq("blocked_user_id", viewer.id),
          ]);

        if (profilesResult.error || swipesResult.error || blocksOutResult.error || blocksInResult.error) {
          console.error("Discovery query error", {
            profiles: profilesResult.error?.message,
            swipes: swipesResult.error?.message,
            blocksOut: blocksOutResult.error?.message,
            blocksIn: blocksInResult.error?.message,
          });
          return jsonResponse({ error: "Could not load discovery profiles" }, 500);
        }

        const alreadySwiped = new Set((swipesResult.data || []).map((row: any) => row.to_user_id));
        const blocked = new Set([
          ...(blocksOutResult.data || []).map((row: any) => row.blocked_user_id),
          ...(blocksInResult.data || []).map((row: any) => row.blocker_user_id),
        ]);
        const candidates = (profilesResult.data || []).filter((candidate: any) =>
          !alreadySwiped.has(candidate.id) &&
          !blocked.has(candidate.id) &&
          profilesAreCompatible(viewer, candidate)
        ).slice(0, 50);

        if (!candidates.length) {
          return jsonResponse({ ok: true, profiles: [] });
        }

        const candidateIds = candidates.map((candidate: any) => candidate.id);
        const [photosResult, interestsResult] = await Promise.all([
          admin
            .from("profile_photos")
            .select("user_id, storage_path, sort_order, is_primary")
            .in("user_id", candidateIds)
            .order("sort_order", { ascending: true }),
          admin
            .from("profile_interests")
            .select("user_id, interest, position")
            .in("user_id", candidateIds)
            .order("position", { ascending: true }),
        ]);

        if (photosResult.error || interestsResult.error) {
          console.error("Discovery extras query error", {
            photos: photosResult.error?.message,
            interests: interestsResult.error?.message,
          });
          return jsonResponse({ error: "Could not load discovery profile details" }, 500);
        }

        const photosByUser = new Map<string, any[]>();
        for (const photo of photosResult.data || []) {
          const existing = photosByUser.get(photo.user_id) || [];
          existing.push({
            public_url: admin.storage.from(PHOTO_BUCKET).getPublicUrl(photo.storage_path).data.publicUrl,
            sort_order: photo.sort_order,
            is_primary: photo.is_primary,
          });
          photosByUser.set(photo.user_id, existing);
        }
        const interestsByUser = new Map<string, string[]>();
        for (const row of interestsResult.data || []) {
          const existing = interestsByUser.get(row.user_id) || [];
          existing.push(row.interest);
          interestsByUser.set(row.user_id, existing);
        }

        const safeProfiles = candidates.map((candidate: any) => {
          const photos = photosByUser.get(candidate.id) || [];
          const primary = photos.find((photo: any) => photo.is_primary) || photos[0] || null;
          return {
            id: candidate.id,
            username: candidate.app_username,
            name: candidate.display_name,
            age: candidate.age,
            gender: candidate.gender,
            location: [candidate.city, candidate.country].filter(Boolean).join(", "),
            bio: candidate.bio,
            purpose: candidate.purpose,
            looking_for: candidate.looking_for || "any",
            interests: interestsByUser.get(candidate.id) || [],
            photos,
            photo: primary?.public_url || null,
          };
        });

        return jsonResponse({ ok: true, profiles: safeProfiles });
      }

      // RECORD SWIPE. The acting user is always the verified Telegram profile.
      const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId : "";
      const swipeAction = typeof body.swipeAction === "string" ? body.swipeAction : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
        return jsonResponse({ error: "Invalid target profile" }, 400);
      }
      if (!["like", "pass", "super_like"].includes(swipeAction)) {
        return jsonResponse({ error: "Invalid swipe action" }, 400);
      }
      if (targetUserId.toLowerCase() === String(viewer.id).toLowerCase()) {
        return jsonResponse({ error: "You cannot swipe on your own profile" }, 400);
      }

      const { data: target, error: targetError } = await admin
        .from("profiles")
        .select("id, gender, show_me, purpose, is_active")
        .eq("id", targetUserId)
        .maybeSingle();
      if (targetError) {
        console.error("Swipe target lookup error", targetError.message);
        return jsonResponse({ error: "Could not verify that profile" }, 500);
      }
      if (!target || !target.is_active) {
        return jsonResponse({ error: "That profile is not available" }, 404);
      }
      if (!profilesAreCompatible(viewer, target)) {
        return jsonResponse({ error: "That profile does not match your current preferences" }, 403);
      }

      const { data: blockRows, error: blockError } = await admin
        .from("blocks")
        .select("blocker_user_id, blocked_user_id")
        .or(`and(blocker_user_id.eq.${viewer.id},blocked_user_id.eq.${target.id}),and(blocker_user_id.eq.${target.id},blocked_user_id.eq.${viewer.id})`);
      if (blockError) {
        console.error("Swipe block check error", blockError.message);
        return jsonResponse({ error: "Could not verify profile availability" }, 500);
      }
      if ((blockRows || []).length) {
        return jsonResponse({ error: "That profile is not available" }, 404);
      }

      const { error: swipeError } = await admin
        .from("swipes")
        .upsert({
          from_user_id: viewer.id,
          to_user_id: target.id,
          action: swipeAction,
          created_at: new Date().toISOString(),
        }, { onConflict: "from_user_id,to_user_id" });
      if (swipeError) {
        console.error("Swipe save error", swipeError.message);
        return jsonResponse({ error: "Could not save your choice" }, 500);
      }

      let matched = false;
      let matchRecord: any = null;
      if (swipeAction === "like" || swipeAction === "super_like") {
        const { data: reverseSwipe, error: reverseSwipeError } = await admin
          .from("swipes")
          .select("id")
          .eq("from_user_id", target.id)
          .eq("to_user_id", viewer.id)
          .in("action", ["like", "super_like"])
          .maybeSingle();
        if (reverseSwipeError) {
          console.error("Mutual like lookup error", reverseSwipeError.message);
          return jsonResponse({ error: "Your like was saved, but matching could not be checked" }, 500);
        }

        if (reverseSwipe) {
          const viewerId = String(viewer.id).toLowerCase();
          const targetId = String(target.id).toLowerCase();
          const userA = viewerId < targetId ? viewer.id : target.id;
          const userB = viewerId < targetId ? target.id : viewer.id;
          const { error: matchUpsertError } = await admin
            .from("matches")
            .upsert({ user_a: userA, user_b: userB }, {
              onConflict: "user_a,user_b",
              ignoreDuplicates: true,
            });
          if (matchUpsertError) {
            console.error("Mutual match save error", matchUpsertError.message);
            return jsonResponse({ error: "Your like was saved, but the match could not be created" }, 500);
          }

          const { data: existingMatch, error: matchLookupError } = await admin
            .from("matches")
            .select("id, user_a, user_b, created_at")
            .eq("user_a", userA)
            .eq("user_b", userB)
            .single();
          if (matchLookupError || !existingMatch) {
            console.error("Mutual match lookup error", matchLookupError?.message);
            return jsonResponse({ error: "Your like was saved, but the match could not be loaded" }, 500);
          }
          matched = true;
          matchRecord = existingMatch;
        }
      }

      return jsonResponse({
        ok: true,
        action: swipeAction,
        matched,
        match: matchRecord,
      });
    }

    // PHOTO ACTIONS
    // Find the database profile using the verified Telegram user ID.
    if (action === "upload_photo" || action === "delete_photo" || action === "set_primary_photo" || action === "replace_primary_photo") {
      const { data: photoProfile, error: photoProfileError } =
        await admin
          .from("profiles")
          .select("id")
          .eq("telegram_user_id", String(telegramUser.id))
          .maybeSingle();

      if (photoProfileError) {
        console.error(
          "Photo profile lookup error",
          photoProfileError.message,
        );
        return jsonResponse({
          error: "Could not verify your profile",
        }, 500);
      }

      if (!photoProfile) {
        return jsonResponse({
          error: "Save your Conect profile before managing photos",
        }, 409);
      }

      // SET THE MAIN PROFILE PHOTO. Only a row belonging to the verified user's profile can be selected.
      if (action === "set_primary_photo") {
        const photoId = cleanString(body.photoId, 80);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(photoId)) {
          return jsonResponse({ error: "Choose a valid profile photo" }, 400);
        }

        const { data: selectedPhoto, error: selectedPhotoError } = await admin
          .from("profile_photos")
          .select("id, storage_path")
          .eq("id", photoId)
          .eq("user_id", photoProfile.id)
          .maybeSingle();

        if (selectedPhotoError) {
          console.error("Main profile photo lookup error", selectedPhotoError.message);
          return jsonResponse({ error: "Could not verify that photo" }, 500);
        }
        if (!selectedPhoto) {
          return jsonResponse({ error: "That photo does not belong to your profile" }, 404);
        }

        const { data: photoRows, error: photoRowsError } = await admin
          .from("profile_photos")
          .select("id, storage_path, sort_order, is_primary, created_at")
          .eq("user_id", photoProfile.id)
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });

        if (photoRowsError) {
          console.error("Main profile photo ordering lookup error", photoRowsError.message);
          return jsonResponse({ error: "Could not load your photo gallery" }, 500);
        }

        const orderedRows = [...(photoRows || [])].sort((a: any, b: any) => {
          if (a.id === b.id) return 0;
          if (a.id === photoId) return -1;
          if (b.id === photoId) return 1;
          return a.sort_order - b.sort_order;
        });

        // Move every row above the current maximum first. A fixed temporary
        // range (for example, 100+) can collide with leftovers from an interrupted
        // earlier reorder and make this action fail repeatedly.
        const temporarySortBase = Math.max(
          0,
          ...orderedRows.map((row: any) => Number(row.sort_order) || 0),
        ) + orderedRows.length + 10;
        // Clear the primary flag while moving rows into the unique temporary range.
        for (let i = 0; i < orderedRows.length; i++) {
          const row = orderedRows[i];
          const { error: temporaryOrderError } = await admin
            .from("profile_photos")
            .update({ sort_order: temporarySortBase + i, is_primary: false })
            .eq("id", row.id)
            .eq("user_id", photoProfile.id);
          if (temporaryOrderError) {
            console.error("Main profile photo temporary reorder error", temporaryOrderError.message);
            return jsonResponse({ error: "Could not prepare the main photo update. Please refresh and try again." }, 500);
          }
        }

        for (let i = 0; i < orderedRows.length; i++) {
          const row = orderedRows[i];
          const { error: orderError } = await admin
            .from("profile_photos")
            .update({ sort_order: i + 1, is_primary: i === 0 })
            .eq("id", row.id)
            .eq("user_id", photoProfile.id);
          if (orderError) {
            console.error("Main profile photo final reorder error", orderError.message);
            return jsonResponse({ error: "Could not update the main profile photo. Please refresh and try again." }, 500);
          }
        }

        const photos = await normalizePhotoOrder(admin, photoProfile.id);
        if (!photos) return jsonResponse({ error: "Photo order could not be refreshed" }, 500);
        return jsonResponse({ ok: true, photos });
      }

      // REPLACE PRIMARY PHOTO with a cropped JPEG. Reuses the existing main-photo
      // row so replacement still works when the gallery already contains six photos.
      if (action === "replace_primary_photo") {
        const photoDataUrl = body.photoDataUrl;
        if (typeof photoDataUrl !== "string" || photoDataUrl.length > MAX_PHOTO_DATA_URL_CHARS) {
          return jsonResponse({ error: "Invalid or oversized photo" }, 413);
        }
        const encodedMatch = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(photoDataUrl);
        if (!encodedMatch) {
          return jsonResponse({ error: "Please choose a photo that can be cropped to JPEG" }, 400);
        }

        let binary: string;
        try {
          binary = atob(encodedMatch[1]);
        } catch {
          return jsonResponse({ error: "Invalid photo data" }, 400);
        }
        const photoBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) photoBytes[i] = binary.charCodeAt(i);
        if (photoBytes.length < 3 || photoBytes.length > MAX_PHOTO_BYTES ||
            photoBytes[0] !== 0xff || photoBytes[1] !== 0xd8 || photoBytes[2] !== 0xff) {
          return jsonResponse({ error: "The cropped photo must be a valid JPEG no larger than 5 MB" }, 400);
        }

        const { data: mainRows, error: mainLookupError } = await admin
          .from("profile_photos")
          .select("id, storage_path, sort_order")
          .eq("user_id", photoProfile.id)
          .order("is_primary", { ascending: false })
          .order("sort_order", { ascending: true })
          .limit(1);

        if (mainLookupError) {
          console.error("Replace main photo lookup error", mainLookupError.message);
          return jsonResponse({ error: "Could not find your current main photo" }, 500);
        }
        if (!mainRows || !mainRows.length) {
          return jsonResponse({ error: "Add a photo to your gallery before replacing the main photo" }, 409);
        }

        const currentMain = mainRows[0];
        const newStoragePath = `${photoProfile.id}/${crypto.randomUUID()}.jpg`;
        const { error: uploadError } = await admin.storage
          .from(PHOTO_BUCKET)
          .upload(newStoragePath, photoBytes, {
            contentType: "image/jpeg",
            cacheControl: "3600",
            upsert: false,
          });
        if (uploadError) {
          console.error("Replace main photo upload error", uploadError.message);
          return jsonResponse({ error: "Could not upload the cropped photo" }, 500);
        }

        const { error: rowUpdateError } = await admin
          .from("profile_photos")
          .update({ storage_path: newStoragePath, is_primary: true, sort_order: 1 })
          .eq("id", currentMain.id)
          .eq("user_id", photoProfile.id);

        if (rowUpdateError) {
          console.error("Replace main photo row update error", rowUpdateError.message);
          const { error: rollbackError } = await admin.storage.from(PHOTO_BUCKET).remove([newStoragePath]);
          if (rollbackError) console.error("Replace main photo rollback error", rollbackError.message);
          return jsonResponse({ error: "Could not save the cropped main photo" }, 500);
        }

        const { error: oldPhotoDeleteError } = await admin.storage
          .from(PHOTO_BUCKET)
          .remove([currentMain.storage_path]);
        if (oldPhotoDeleteError) {
          // DB now references the new photo; report incomplete cleanup without
          // rolling back the valid main image.
          console.error("Old main photo cleanup error", oldPhotoDeleteError.message);
        }

        const photos = await normalizePhotoOrder(admin, photoProfile.id);
        if (!photos) return jsonResponse({ error: "The new main photo was saved, but the gallery order could not be refreshed" }, 500);
        return jsonResponse({ ok: true, photos, cleanupWarning: Boolean(oldPhotoDeleteError) });
      }

      // UPLOAD PHOTO
      if (action === "upload_photo") {
        const photoDataUrl = body.photoDataUrl;

        if (
          typeof photoDataUrl !== "string" ||
          photoDataUrl.length > MAX_PHOTO_DATA_URL_CHARS
        ) {
          return jsonResponse({
            error: "Invalid or oversized photo",
          }, 413);
        }

        // This endpoint accepts the JPEG data URL generated by the
        // current browser image-compression code.
        const match =
          /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
            photoDataUrl,
          );

        if (!match) {
          return jsonResponse({
            error: "Please select a photo that can be converted to JPEG",
          }, 400);
        }

        let binary: string;

        try {
          binary = atob(match[1]);
        } catch {
          return jsonResponse({
            error: "Invalid photo data",
          }, 400);
        }

        const photoBytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
          photoBytes[i] = binary.charCodeAt(i);
        }

        // Check size and JPEG signature before storing.
        if (
          photoBytes.length < 3 ||
          photoBytes.length > MAX_PHOTO_BYTES ||
          photoBytes[0] !== 0xff ||
          photoBytes[1] !== 0xd8 ||
          photoBytes[2] !== 0xff
        ) {
          return jsonResponse({
            error: "The photo must be a valid JPEG no larger than 5 MB",
          }, 400);
        }

        // Never accept a storage path supplied by the browser.
        // Generate a unique, user-specific path on the server.
        const storagePath =
          `${photoProfile.id}/${crypto.randomUUID()}.jpg`;

        // This database function enforces the six-photo limit under
        // a profile-row lock.
        const { data: reservations, error: reservationError } =
          await admin.rpc("reserve_profile_photo", {
            p_user_id: photoProfile.id,
            p_storage_path: storagePath,
          });

        if (reservationError) {
          if (
            reservationError.message.toLowerCase().includes(
              "maximum of 6 photos",
            )
          ) {
            return jsonResponse({
              error: "You can have up to 6 profile photos",
            }, 409);
          }

          console.error(
            "Photo reservation error",
            reservationError.message,
          );

          return jsonResponse({
            error: "Could not reserve a photo slot",
          }, 500);
        }

        const reservation = Array.isArray(reservations)
          ? reservations[0]
          : reservations;

        if (!reservation?.id) {
          return jsonResponse({
            error: "Could not reserve a photo slot",
          }, 500);
        }

        const { error: uploadError } = await admin.storage
          .from(PHOTO_BUCKET)
          .upload(storagePath, photoBytes, {
            contentType: "image/jpeg",
            cacheControl: "3600",
            upsert: false,
          });

        if (uploadError) {
          console.error(
            "Photo storage upload error",
            uploadError.message,
          );

          // Try to remove any partial object and release the slot.
          const { error: storageCleanupError } = await admin.storage
            .from(PHOTO_BUCKET)
            .remove([storagePath]);

          if (storageCleanupError) {
            console.error(
              "Photo storage cleanup error",
              storageCleanupError.message,
            );
          }

          const { error: rowCleanupError } = await admin
            .from("profile_photos")
            .delete()
            .eq("id", reservation.id)
            .eq("user_id", photoProfile.id);

          if (rowCleanupError) {
            console.error(
              "Photo reservation cleanup error",
              rowCleanupError.message,
            );
          } else {
            await normalizePhotoOrder(admin, photoProfile.id);
          }

          return jsonResponse({
            error: "Photo upload failed",
          }, 500);
        }

        const { data: publicData } = admin.storage
          .from(PHOTO_BUCKET)
          .getPublicUrl(storagePath);

        return jsonResponse({
          ok: true,
          photo: {
            id: reservation.id,
            storage_path: storagePath,
            sort_order: reservation.sort_order,
            is_primary: reservation.is_primary,
            public_url: publicData.publicUrl,
          },
        });
      }

      // DELETE PHOTO
      const storagePath = cleanString(body.storagePath, 500);

      if (
        !storagePath.startsWith(`${photoProfile.id}/`) ||
        storagePath.includes("..") ||
        storagePath.includes("\\")
      ) {
        return jsonResponse({
          error: "Invalid photo path",
        }, 400);
      }

      // A path prefix alone is not sufficient; also confirm that the
      // database record belongs to this verified user's profile.
      const { data: photoRow, error: photoLookupError } = await admin
        .from("profile_photos")
        .select("id, storage_path")
        .eq("user_id", photoProfile.id)
        .eq("storage_path", storagePath)
        .maybeSingle();

      if (photoLookupError) {
        console.error(
          "Photo lookup error",
          photoLookupError.message,
        );
        return jsonResponse({
          error: "Could not find the photo",
        }, 500);
      }

      if (!photoRow) {
        return jsonResponse({
          error: "Photo not found or you do not own it",
        }, 404);
      }

      const { error: removeError } = await admin.storage
        .from(PHOTO_BUCKET)
        .remove([photoRow.storage_path]);

      if (removeError) {
        console.error(
          "Photo storage deletion error",
          removeError.message,
        );
        return jsonResponse({
          error: "Could not delete the photo",
        }, 500);
      }

      const { error: deleteRowError } = await admin
        .from("profile_photos")
        .delete()
        .eq("id", photoRow.id)
        .eq("user_id", photoProfile.id);

      if (deleteRowError) {
        console.error(
          "Photo record deletion error",
          deleteRowError.message,
        );
        return jsonResponse({
          error: "The image was removed, but its database record needs cleanup",
        }, 500);
      }

      const photos = await normalizePhotoOrder(
        admin,
        photoProfile.id,
      );

      if (!photos) {
        return jsonResponse({
          error: "Photo deleted, but the gallery order could not be updated",
        }, 500);
      }

      return jsonResponse({
        ok: true,
        deleted: true,
        photos,
      });
    }

    // LOAD PROFILE
    if (action === "load_profile") {
      const { data: profile, error } = await admin
        .from("profiles")
        .select(
          "id, app_username, display_name, age, gender, interested_in, show_me, looking_for, country, city, bio, purpose, email",
        )
        .eq("telegram_user_id", String(telegramUser.id))
        .maybeSingle();

      if (error) {
        console.error("load_profile database error", error.message);
        return jsonResponse({
          error: "Could not load the saved profile",
        }, 500);
      }

      if (!profile) {
        return jsonResponse({
          ok: true,
          profile: null,
          interests: [],
          photos: [],
        });
      }

      const { data: interestRows, error: interestError } = await admin
        .from("profile_interests")
        .select("interest, position")
        .eq("user_id", profile.id)
        .order("position", { ascending: true });

      if (interestError) {
        console.error(
          "load interests database error",
          interestError.message,
        );
        return jsonResponse({
          error: "Could not load saved interests",
        }, 500);
      }

      const { data: photoRows, error: photoError } = await admin
        .from("profile_photos")
        .select("id, storage_path, sort_order, is_primary, created_at")
        .eq("user_id", profile.id)
        .order("sort_order", { ascending: true });

      if (photoError) {
        console.error(
          "load photos database error",
          photoError.message,
        );
        return jsonResponse({
          error: "Could not load saved photos",
        }, 500);
      }

      const photos = (photoRows || []).map((photo) => ({
        ...photo,
        public_url: admin.storage
          .from(PHOTO_BUCKET)
          .getPublicUrl(photo.storage_path).data.publicUrl,
      }));

      return jsonResponse({
        ok: true,
        profile,
        interests: (interestRows || []).map((row) => row.interest),
        photos,
      });
    }

    // SAVE PROFILE
    const input = (
      body.profile && typeof body.profile === "object"
    )
      ? body.profile as Record<string, unknown>
      : {};

    const appUsername = cleanString(
      input.app_username,
      20,
    ).toLowerCase();

    const displayName = cleanString(input.display_name, 50);
    const age = Number(input.age);
    const gender = cleanString(input.gender, 40);
    const interestedIn =
      cleanString(input.interested_in, 40) || "Any";
    const showMe = cleanString(input.show_me, 40) || "Any";
    const lookingFor = cleanString(input.looking_for, 40) || "any";
    const country = cleanString(input.country, 100);
    const city = cleanString(input.city, 100);
    const bio = cleanString(input.bio, 500);
    const purpose = cleanString(input.purpose, 20) || "both";
    const email = cleanString(input.email, 254).toLowerCase();

    const interestsRaw = Array.isArray(input.interests)
      ? input.interests
      : [];

    const interests = [
      ...new Set(
        interestsRaw
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];

    if (!/^[A-Za-z0-9_]{3,20}$/.test(appUsername)) {
      return jsonResponse({
        error: "Username must be 3–20 letters, numbers, or underscores",
      }, 400);
    }

    if (!displayName) {
      return jsonResponse({
        error: "Display name is required",
      }, 400);
    }

    if (!Number.isInteger(age) || age < 18 || age > 99) {
      return jsonResponse({
        error: "Age must be between 18 and 99",
      }, 400);
    }

    if (!allowedGenders.has(gender)) {
      return jsonResponse({
        error: "Choose a valid gender",
      }, 400);
    }

    if (!allowedOrientations.has(interestedIn)) {
      return jsonResponse({
        error: "Choose a valid Interested in option",
      }, 400);
    }

    if (!allowedShowMe.has(showMe)) {
      return jsonResponse({
        error: "Choose a valid Show me option",
      }, 400);
    }

    if (!allowedLookingFor.has(lookingFor)) {
      return jsonResponse({ error: "Choose a valid Looking for option" }, 400);
    }

    if (!country || !city) {
      return jsonResponse({
        error: "Country and city are required",
      }, 400);
    }

    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
      return jsonResponse({ error: "Enter a valid email address or leave it blank" }, 400);
    }

    if (!allowedPurposes.has(purpose)) {
      return jsonResponse({
        error: "Choose a valid purpose",
      }, 400);
    }

    if (
      interests.length > 10 ||
      interests.some((x) => x.length > 80)
    ) {
      return jsonResponse({
        error: "Choose up to 10 valid interests",
      }, 400);
    }

    const row = {
      telegram_user_id: String(telegramUser.id),
      telegram_username:
        typeof telegramUser.username === "string"
          ? telegramUser.username
          : null,
      app_username: appUsername,
      display_name: displayName,
      age,
      gender,
      interested_in: interestedIn,
      show_me: showMe,
      looking_for: lookingFor,
      country,
      city,
      bio,
      purpose,
      email: email || null,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    const { data: savedProfile, error: profileError } = await admin
      .from("profiles")
      .upsert(row, { onConflict: "telegram_user_id" })
      .select(
        "id, app_username, display_name, age, gender, interested_in, show_me, looking_for, country, city, bio, purpose",
      )
      .single();

    if (profileError || !savedProfile) {
      console.error(
        "save profile database error",
        profileError?.message,
      );

      const conflict = profileError?.code === "23505";

      return jsonResponse({
        error: conflict
          ? "That Conect username is already taken. Choose another username."
          : "Could not save the profile",
      }, conflict ? 409 : 500);
    }

    const { error: deleteError } = await admin
      .from("profile_interests")
      .delete()
      .eq("user_id", savedProfile.id);

    if (deleteError) {
      console.error(
        "clear interests database error",
        deleteError.message,
      );
      return jsonResponse({
        error: "Profile was saved, but interests could not be updated",
      }, 500);
    }

    if (interests.length) {
      const interestRows = interests.map((interest, i) => ({
        user_id: savedProfile.id,
        interest,
        position: i + 1,
      }));

      const { error: insertError } = await admin
        .from("profile_interests")
        .insert(interestRows);

      if (insertError) {
        console.error(
          "insert interests database error",
          insertError.message,
        );
        return jsonResponse({
          error: "Profile was saved, but interests could not be updated",
        }, 500);
      }
    }

    return jsonResponse({
      ok: true,
      profile: savedProfile,
      interests,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Request failed";

    if (
      message.includes("signature") ||
      message.includes("expired") ||
      message.includes("Telegram user")
    ) {
      return jsonResponse({ error: message }, 401);
    }

    console.error("telegram-session error", message);

    return jsonResponse({
      error: "Internal server error",
    }, 500);
  }
});
