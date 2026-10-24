import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const encoder = new TextEncoder();
const PHOTO_BUCKET = "profile-photos";
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
      action !== "load_discovery" &&
      action !== "load_relationships" &&
      action !== "record_swipe" &&
      action !== "load_messages" &&
      action !== "send_message" &&
      action !== "load_chat_updates" &&
      action !== "block_user" &&
      action !== "report_user"
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

    // REAL DISCOVERY AND SWIPES
    // Every operation identifies the caller from the verified Telegram ID,
    // never from a user ID supplied by the browser.
    if (
      action === "load_discovery" ||
      action === "load_relationships" ||
      action === "record_swipe" ||
      action === "load_messages" ||
      action === "send_message" ||
      action === "load_chat_updates" ||
      action === "block_user" ||
      action === "report_user"
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
      if (action === "block_user" || action === "report_user") {
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
              .select("id, match_id, sender_user_id, body, created_at, read_at")
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

      // PRIVATE MESSAGING: only participants in a real, active match can read/send.
      if (action === "load_messages" || action === "send_message") {
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

        if (action === "send_message") {
          const messageBody = typeof body.message === "string" ? body.message.trim() : "";
          if (!messageBody || messageBody.length > 4000) {
            return jsonResponse({ error: "Messages must contain 1–4000 characters" }, 400);
          }

          const { data: newMessage, error: insertError } = await admin
            .from("messages")
            .insert({
              match_id: matchRow.id,
              sender_user_id: viewer.id,
              body: messageBody,
            })
            .select("id, match_id, sender_user_id, body, created_at, read_at")
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
          .select("id, match_id, sender_user_id, body, created_at, read_at")
          .eq("match_id", matchRow.id)
          .order("created_at", { ascending: true })
          .limit(200);

        if (messagesError) {
          console.error("Message history query error", messagesError.message);
          return jsonResponse({ error: "Could not load conversation messages" }, 500);
        }

        return jsonResponse({
          ok: true,
          messages: (messageRows || []).map((message: any) => ({
            ...message,
            is_mine: message.sender_user_id === viewer.id,
          })),
        });
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

      if (action === "load_discovery") {
        const [profilesResult, swipesResult, blocksOutResult, blocksInResult] =
          await Promise.all([
            admin
              .from("profiles")
              .select("id, app_username, display_name, age, gender, country, city, bio, purpose, show_me, is_active, created_at")
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
    if (action === "upload_photo" || action === "delete_photo") {
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
          "id, app_username, display_name, age, gender, interested_in, show_me, country, city, bio, purpose",
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
    const country = cleanString(input.country, 100);
    const city = cleanString(input.city, 100);
    const bio = cleanString(input.bio, 500);
    const purpose = cleanString(input.purpose, 20) || "both";

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

    if (!country || !city) {
      return jsonResponse({
        error: "Country and city are required",
      }, 400);
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
      country,
      city,
      bio,
      purpose,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    const { data: savedProfile, error: profileError } = await admin
      .from("profiles")
      .upsert(row, { onConflict: "telegram_user_id" })
      .select(
        "id, app_username, display_name, age, gender, interested_in, show_me, country, city, bio, purpose",
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
