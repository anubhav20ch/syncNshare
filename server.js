const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool } = require("pg");
const { postgresConfig } = require("./postgres-config");
const { clone, loadState, persistStateDiff } = require("./postgres-store");
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, ".data"));
const DB_FILE = path.join(DATA_DIR, "database.json");
const random = (n = 24) => crypto.randomBytes(n).toString("base64url");
const blank = () => ({
  users: [],
  follows: [],
  friendRequests: [],
  roomPauseRequests: [],
  sessionPauseRequests: [],
  roomHistory: [],
  roomJoinRequests: [],
  roomInvites: [],
  rooms: [],
  members: [],
  queue: [],
  votes: [],
  messages: [],
  authSessions: [],
});
if (!process.env.DATABASE_URL && !process.env.VERCEL)
  fs.mkdirSync(DATA_DIR, { recursive: true });
function normalizeDb(value) {
  const state =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : blank();
  for (const key of [
    "users",
    "follows",
    "friendRequests",
    "roomPauseRequests",
    "sessionPauseRequests",
    "roomHistory",
    "roomJoinRequests",
    "roomInvites",
    "rooms",
    "members",
    "queue",
    "votes",
    "messages",
    "sessions",
    "sessionMessages",
    "listenerSessions",
    "closeFriends",
    "sessionRequests",
    "authSessions",
  ])
    if (!Array.isArray(state[key])) state[key] = [];
  const closeFriendKeys = new Set();
  state.closeFriends = state.closeFriends.filter((f) => {
    const key = `${f.hostId}:${f.userId}`;
    if (
      !f.hostId ||
      !f.userId ||
      f.hostId === f.userId ||
      closeFriendKeys.has(key) ||
      !(
        state.follows.some((r) => r.from === f.hostId && r.to === f.userId) ||
        state.friendRequests.some(
          (r) =>
            r.status === "accepted" &&
            ((r.from === f.hostId && r.to === f.userId) ||
              (r.from === f.userId && r.to === f.hostId)),
        )
      )
    )
      return false;
    closeFriendKeys.add(key);
    return true;
  });
  state.friendRequests = state.friendRequests.filter(
    (r) =>
      r &&
      typeof r === "object" &&
      r.from &&
      r.to &&
      r.from !== r.to &&
      ["pending", "accepted", "declined"].includes(r.status),
  );
  state.authSessions = state.authSessions.filter(
    (s) =>
      s &&
      typeof s.tokenHash === "string" &&
      s.userId &&
      Number(s.expires) > Date.now(),
  );
  return state;
}
function readDbFile() {
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return blank();
    throw error;
  }
}
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      ...postgresConfig(),
      max: 1,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10000,
    })
  : null;
const dbContext = new AsyncLocalStorage();
let localDb = pgPool || process.env.VERCEL ? blank() : readDbFile();
const db = new Proxy(
  {},
  {
    get(_target, key) {
      return (dbContext.getStore()?.state || localDb)[key];
    },
    set(_target, key, value) {
      (dbContext.getStore()?.state || localDb)[key] = value;
      return true;
    },
  },
);
let saveChain = Promise.resolve();
function save() {
  const context = dbContext.getStore();
  if (context?.client) {
    const snapshot = clone(context.state);
    context.pendingSave = context.pendingSave.then(async () => {
      await persistStateDiff(context.client, context.baseline, snapshot);
      context.baseline = snapshot;
    });
    return context.pendingSave;
  }
  const state = context?.state || localDb;
  localDb = state;
  saveChain = saveChain.then(() =>
    fs.promises
      .writeFile(DB_FILE + ".tmp", JSON.stringify(state), { mode: 0o600 })
      .then(() => fs.promises.rename(DB_FILE + ".tmp", DB_FILE)),
  );
  return saveChain;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function acquireDbLock() {
  const lockPath = DB_FILE + ".lock";
  while (true) {
    const nonce = random(8);
    try {
      const handle = await fs.promises.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }),
      );
      return async () => {
        await handle.close().catch(() => {});
        try {
          const lock = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
          if (lock.nonce === nonce) await fs.promises.unlink(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const [raw, stat] = await Promise.all([
          fs.promises.readFile(lockPath, "utf8"),
          fs.promises.stat(lockPath),
        ]);
        let lock = null;
        try {
          lock = JSON.parse(raw);
        } catch {}
        let ownerAlive = !!lock?.pid;
        if (ownerAlive) {
          try {
            process.kill(lock.pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") ownerAlive = false;
          }
        }
        if (!ownerAlive && Date.now() - stat.mtimeMs > 1000)
          await fs.promises.unlink(lockPath).catch(() => {});
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await wait(10);
    }
  }
}
async function withFreshDb(fn, res) {
  if (pgPool) {
    let client;
    try {
      client = await pgPool.connect();
      await client.query("BEGIN");
      // The existing route layer mutates in-memory collections. Serialize these
      // short database transactions until routes use row-scoped SQL updates.
      await client.query("SELECT pg_advisory_xact_lock(734821, 1)");
      const state = normalizeDb(await loadState(client, blank));
      const context = {
        state,
        client,
        baseline: clone(state),
        pendingSave: Promise.resolve(),
      };
      await dbContext.run(context, fn);
      await context.pendingSave;
      await client.query("COMMIT");
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      if (!res.headersSent)
        send(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Could not read or update shared application data.",
        });
    } finally {
      client?.release();
    }
    return;
  }
  if (process.env.VERCEL) {
    send(res, 503, { error: "DATABASE_URL is required for cloud deployment." });
    return;
  }
  let release;
  try {
    release = await acquireDbLock();
    const state = readDbFile();
    await dbContext.run({ state }, fn);
    localDb = state;
  } catch (error) {
    if (!res.headersSent)
      send(res, error.status || 500, {
        error: error.status
          ? error.message
          : "Could not read or update shared application data.",
      });
  } finally {
    if (release) await release();
  }
}
function send(res, status, value, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(JSON.stringify(value));
}
function cookieFor(req, sid) {
  const secure =
    req.socket.encrypted || req.headers["x-forwarded-proto"] === "https"
      ? "; Secure"
      : "";
  return `sn_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}
function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function createSession(userId) {
  const token = random(32);
  db.authSessions.push({
    tokenHash: sessionTokenHash(token),
    userId,
    expires: Date.now() + 30 * 86400000,
  });
  return token;
}
function safeUser(u) {
  if (!u) {
    return {
      id: "",
      username: "unknown",
      name: "User",
      bio: "",
      avatar: "",
      visibility: "everyone",
      createdAt: "",
    };
  }
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    bio: u.bio || "",
    avatar: u.avatar || "",
    visibility: u.visibility || "everyone",
    createdAt: u.createdAt,
  };
}
function member(roomId, userId) {
  return db.members.find((m) => m.roomId === roomId && m.userId === userId);
}
function roomFor(id) {
  return db.rooms.find((r) => r.id === id);
}
function areFriends(userId1, userId2) {
  if (!userId1 || !userId2 || userId1 === userId2) return false;
  return db.friendRequests.some(
    (r) =>
      r.status === "accepted" &&
      ((r.from === userId1 && r.to === userId2) ||
        (r.from === userId2 && r.to === userId1)),
  );
}
function getFriendshipStatus(viewerId, targetId) {
  if (!viewerId || !targetId) return "none";
  if (viewerId === targetId) return "self";
  const req = db.friendRequests.find(
    (r) =>
      (r.from === viewerId && r.to === targetId) ||
      (r.from === targetId && r.to === viewerId),
  );
  if (!req) return "none";
  if (req.status === "accepted") return "friends";
  if (req.status === "pending") {
    return req.from === viewerId ? "outgoing_pending" : "incoming_pending";
  }
  return "none";
}
function getFriendsList(userId) {
  const friendIds = new Set();
  for (const r of db.friendRequests) {
    if (r.status === "accepted") {
      if (r.from === userId) friendIds.add(r.to);
      else if (r.to === userId) friendIds.add(r.from);
    }
  }
  return db.users.filter((u) => friendIds.has(u.id)).map(safeUser);
}
function formatPersonForViewer(person, viewer) {
  const friendshipStatus = getFriendshipStatus(viewer.id, person.id);
  const req = db.friendRequests.find(
    (r) =>
      (r.from === viewer.id && r.to === person.id) ||
      (r.from === person.id && r.to === viewer.id),
  );
  const following =
    friendshipStatus === "friends" ||
    db.follows.some((f) => f.from === viewer.id && f.to === person.id);
  const active =
    person.id === viewer.id
      ? null
      : db.sessions.find(
          (s) => s.hostId === person.id && s.status === "active",
        );
  const visible =
    active && active.audience !== "off" && audienceAllows(active, viewer);
  const activity = visible
    ? {
        sessionId: active.id,
        videoId: active.videoId,
        title: active.title,
        playback: active.playback,
        updatedAt: active.updatedAt,
        audience: active.audience,
        participants: (active.participants || []).length,
        thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(active.videoId)}/hqdefault.jpg`,
      }
    : null;
  const canSeePrivate = canSeeActivity(person, viewer);
  const activePrivateRoom = canSeePrivate
    ? (db.rooms.find(
        (rm) =>
          rm.isPrivate &&
          (rm.status || "active") === "active" &&
          rm.ownerId === person.id,
      ) ||
      db.rooms.find(
        (rm) =>
          rm.isPrivate &&
          (rm.status || "active") === "active" &&
          member(rm.id, person.id),
      ))
    : null;
  const isPrivateMember = activePrivateRoom ? !!member(activePrivateRoom.id, viewer.id) : false;
  const hasRequestedPrivate = activePrivateRoom
    ? (db.roomJoinRequests || []).some(
        (jr) =>
          jr.roomId === activePrivateRoom.id &&
          jr.userId === viewer.id &&
          jr.status === "pending",
      )
    : false;
  const currentQueueItem = activePrivateRoom
    ? db.queue.find((q) => q.id === activePrivateRoom.currentQueueId)
    : null;
  const roomOwner = activePrivateRoom
    ? db.users.find((u) => u.id === activePrivateRoom.ownerId)
    : null;
  const privateRoomInfo = activePrivateRoom
    ? {
        id: activePrivateRoom.id,
        name: activePrivateRoom.name,
        isPrivate: true,
        isCornerRoom: !!activePrivateRoom.isCornerRoom,
        trackTitle:
          currentQueueItem?.title ||
          (activePrivateRoom.isCornerRoom ? person.corner?.title : null) ||
          "Private listening session",
        playback: activePrivateRoom.playback || "paused",
        isMember: isPrivateMember,
        hasRequestedJoin: hasRequestedPrivate,
        ownerId: activePrivateRoom.ownerId,
        hostName: roomOwner?.name || "Host",
        hostUsername: roomOwner?.username || "",
        isHost: activePrivateRoom.ownerId === person.id,
      }
    : null;
  return {
    ...safeUser(person),
    friendshipStatus,
    requestId: req?.id || null,
    following,
    isSelf: person.id === viewer.id,
    activity,
    cornerRoom: privateRoomInfo,
    privateRoom: privateRoomInfo,
    sharing: !!visible,
  };
}
function canSeeActivity(owner, viewer) {
  if (!owner) return false;
  if (owner.id === viewer?.id || owner.visibility === "everyone") return true;
  if (owner.visibility === "followers" || owner.visibility === "friends")
    return (
      areFriends(owner.id, viewer?.id) ||
      db.follows.some((f) => f.from === viewer?.id && f.to === owner.id)
    );
  return false;
}
function recordRoomHistory(r) {
  if (!r.currentQueueId) return;
  const q = db.queue.find(
    (item) => item.id === r.currentQueueId && item.roomId === r.id,
  );
  if (!q) return;
  db.roomHistory = db.roomHistory || [];
  const last = db.roomHistory
    .filter((h) => h.roomId === r.id)
    .slice(-1)[0];
  if (
    last &&
    (last.queueId === q.id ||
      (last.videoId && q.videoId && last.videoId === q.videoId) ||
      (last.playlistId && q.playlistId && last.playlistId === q.playlistId)) &&
    Date.now() - (last.playedAt || 0) < 30000
  ) {
    return;
  }
  db.roomHistory.push({
    id: random(10),
    roomId: r.id,
    queueId: q.id,
    type: q.type,
    videoId: q.videoId || null,
    playlistId: q.playlistId || null,
    title: q.title,
    by: q.by,
    playedAt: Date.now(),
  });
}
function ensureCornerRoom(user, corner) {
  if (!corner || !corner.videoId) return null;
  let r = db.rooms.find(
    (rm) =>
      rm.ownerId === user.id &&
      rm.isCornerRoom &&
      (rm.status || "active") === "active",
  );
  if (!r) {
    r = {
      id: random(12),
      name: `${user.name}'s Corner Room`,
      isPrivate: true,
      isCornerRoom: true,
      ownerId: user.id,
      code: random(6).toUpperCase().slice(0, 8),
      createdAt: new Date().toISOString(),
      status: "active",
      playback: corner.playback || "playing",
      playbackPosition: Number(corner.position) || 0,
      playbackUpdatedAt: Date.now(),
    };
    db.rooms.push(r);
  } else {
    r.playback = corner.playback || "paused";
    r.playbackPosition = Number(corner.position) || 0;
    r.playbackUpdatedAt = Date.now();
  }
  if (!member(r.id, user.id)) {
    db.members.push({ roomId: r.id, userId: user.id, role: "host" });
  }

  const queueItems =
    corner.queue && corner.queue.length > 0
      ? corner.queue
      : [{ videoId: corner.videoId, title: corner.title }];
  for (const item of queueItems) {
    if (
      item.videoId &&
      !db.queue.some((q) => q.roomId === r.id && q.videoId === item.videoId)
    ) {
      db.queue.push({
        id: random(10),
        roomId: r.id,
        type: "video",
        videoId: item.videoId,
        playlistId: null,
        title: item.title || `YouTube video ${item.videoId}`,
        by: safeUser(user),
        createdAt: new Date().toISOString(),
      });
    }
  }
  const currentInQueue = db.queue.find(
    (q) => q.roomId === r.id && q.videoId === corner.videoId,
  );
  if (currentInQueue) {
    r.currentQueueId = currentInQueue.id;
    if (r.playback === "playing") {
      recordRoomHistory(r);
    }
  }
  user.cornerRoomId = r.id;
  return r;
}
function roomView(r, viewer) {
  const isHost = member(r.id, viewer.id)?.role === "host";
  const isUserMember = !!member(r.id, viewer.id);
  const nowPlaying = db.queue.find((q) => q.id === r.currentQueueId) || null;
  const pendingPauseRequests = (db.roomPauseRequests || [])
    .filter((pr) => pr.roomId === r.id && pr.status === "pending")
    .map((pr) => {
      const u = db.users.find((x) => x.id === pr.userId);
      return {
        id: pr.id,
        userId: pr.userId,
        userName: u?.name || "Member",
        userUsername: u?.username || "",
        createdAt: pr.createdAt,
        isMine: pr.userId === viewer.id,
      };
    });
  const myPauseRequest = pendingPauseRequests.find((pr) => pr.isMine) || null;
  const pendingJoinRequests = (db.roomJoinRequests || [])
    .filter((jr) => jr.roomId === r.id && jr.status === "pending")
    .map((jr) => {
      const u = db.users.find((x) => x.id === jr.userId);
      return {
        id: jr.id,
        roomId: r.id,
        userId: jr.userId,
        userName: u?.name || jr.userName || "User",
        userUsername: u?.username || jr.userUsername || "",
        userHandle: u?.username || jr.userUsername || "",
        createdAt: jr.createdAt,
        isMine: jr.userId === viewer.id,
      };
    });
  const myJoinRequest =
    pendingJoinRequests.find((jr) => jr.isMine) ||
    (db.roomJoinRequests || []).find(
      (jr) =>
        jr.roomId === r.id && jr.userId === viewer.id && jr.status === "pending",
    ) ||
    null;
  const history = (db.roomHistory || [])
    .filter((h) => h.roomId === r.id)
    .slice(-30)
    .reverse();
  const messages = (db.messages || [])
    .filter((m) => m.roomId === r.id)
    .slice(-100);
  return {
    id: r.id,
    name: r.name,
    isPrivate: r.isPrivate,
    isCornerRoom: !!r.isCornerRoom,
    code: isHost || isUserMember ? r.code : (r.isPrivate ? undefined : r.code),
    ownerId: r.ownerId,
    createdAt: r.createdAt,
    status: r.status || "active",
    currentQueueId: r.currentQueueId || null,
    playback: r.playback || "paused",
    playbackPosition: Number(r.playbackPosition) || 0,
    playbackUpdatedAt: Number(r.playbackUpdatedAt) || Date.now(),
    members: db.members
      .filter((m) => m.roomId === r.id)
      .map((m) => ({
        user: safeUser(db.users.find((u) => u.id === m.userId)),
        role: m.role,
      })),
    queue: db.queue
      .filter((q) => q.roomId === r.id)
      .map((q) => ({
        ...q,
        votes: db.votes
          .filter((v) => v.queueId === q.id)
          .reduce((n, v) => n + v.value, 0),
        myVote:
          db.votes.find((v) => v.queueId === q.id && v.userId === viewer.id)
            ?.value || 0,
      })),
    messages,
    host: isHost,
    isMember: isUserMember,
    nowPlaying,
    pauseRequests: pendingPauseRequests,
    myPauseRequest,
    joinRequests: pendingJoinRequests,
    myJoinRequest,
    history,
  };
}
async function body(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 20000)
      throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}
function auth(req) {
  const sid = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("sn_session="))
    ?.slice(11);
  const session =
    sid && db.authSessions.find((s) => s.tokenHash === sessionTokenHash(sid));
  if (!session || session.expires < Date.now())
    throw Object.assign(new Error("Please sign in to continue."), {
      status: 401,
    });
  const user = db.users.find((u) => u.id === session.userId);
  if (!user)
    throw Object.assign(new Error("Please sign in to continue."), {
      status: 401,
    });
  return user;
}
function requireRoom(id, user) {
  const r = roomFor(id);
  if (!r) throw Object.assign(new Error("Room not found."), { status: 404 });
  if (!member(id, user.id))
    throw Object.assign(new Error("Join this room to view its content."), {
      status: 403,
    });
  return r;
}
function requireActiveRoom(id, user) {
  const r = requireRoom(id, user);
  if ((r.status || "active") !== "active")
    throw Object.assign(
      new Error(
        "This room is closed. The host must start it before it can be used.",
      ),
      { status: 409 },
    );
  return r;
}
function activeSessionFor(userId) {
  return (
    db.sessions.find((s) => s.hostId === userId && s.status === "active") ||
    null
  );
}
function audienceAllows(s, viewer) {
  return (
    s.audience === "everyone" ||
    ((s.audience === "followers" || s.audience === "friends") &&
      (areFriends(s.hostId, viewer.id) ||
        db.follows.some((f) => f.from === viewer.id && f.to === s.hostId))) ||
    (s.audience === "close-friends" &&
      db.closeFriends.some(
        (f) => f.hostId === s.hostId && f.userId === viewer.id,
      ) &&
      (areFriends(s.hostId, viewer.id) ||
        db.follows.some((f) => f.from === s.hostId && f.to === viewer.id)))
  );
}
function sessionCanView(s, user) {
  return !!s && (s.hostId === user.id || s.participants?.includes(user.id));
}
function sessionView(s, user) {
  if (!sessionCanView(s, user))
    throw Object.assign(new Error("Session not found."), { status: 404 });
  const host = db.users.find((u) => u.id === s.hostId);
  const corner = host?.corner || {};
  const pendingPauseRequests = (db.sessionPauseRequests || [])
    .filter((pr) => pr.sessionId === s.id && pr.status === "pending")
    .map((pr) => {
      const u = db.users.find((x) => x.id === pr.userId);
      return {
        id: pr.id,
        userId: pr.userId,
        userName: u?.name || "Listener",
        userUsername: u?.username || "",
        createdAt: pr.createdAt,
        isMine: pr.userId === user.id,
      };
    });
  const myPauseRequest = pendingPauseRequests.find((pr) => pr.isMine) || null;
  return {
    id: s.id,
    hostId: s.hostId,
    host: safeUser(host),
    videoId: s.videoId,
    title: s.title,
    playback: s.playback,
    position: Number(s.position) || 0,
    updatedAt: s.updatedAt,
    audience: s.audience,
    status: s.status,
    hostActive: s.status === "active" && Date.now() - s.hostSeenAt < 45000,
    participants: (s.participants || [])
      .map((id) => db.users.find((u) => u.id === id))
      .filter(Boolean)
      .map(safeUser),
    queue: (corner.queue || []).map((q) => ({
      id: q.id,
      videoId: q.videoId,
      title: q.title,
    })),
    isHost: s.hostId === user.id,
    messages: db.sessionMessages
      .filter((x) => x.sessionId === s.id)
      .slice(-100),
    pauseRequests: pendingPauseRequests,
    myPauseRequest,
  };
}
function expireSessions() {
  let changed = false;
  for (const s of db.sessions)
    if (
      s.status === "active" &&
      Date.now() - Number(s.hostSeenAt || 0) > 45000
    ) {
      s.status = "ended";
      s.endedAt = Date.now();
      changed = true;
    }
  if (changed) save().catch(() => {});
}
async function route(req, res) {
  let m;
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;
  try {
    if (p.startsWith("/api/")) {
      const data = ["POST", "PUT", "PATCH"].includes(method)
        ? await body(req)
        : {};
      if (p === "/api/auth/signup" && method === "POST") {
        const username = String(data.username || "")
          .trim()
          .toLowerCase();
        const name = String(data.name || "").trim();
        const password = String(data.password || "");
        if (
          !/^[a-z0-9_]{3,20}$/.test(username) ||
          !name ||
          name.length > 50 ||
          password.length < 8 ||
          password.length > 128
        )
          throw Object.assign(
            new Error(
              "Use a 3–20 character username, display name, and password of at least 8 characters.",
            ),
            { status: 400 },
          );
        if (db.users.some((u) => u.username === username))
          throw Object.assign(new Error("That username is already taken."), {
            status: 409,
          });
        const salt = crypto.randomBytes(16).toString("hex");
        const user = {
          id: random(12),
          username,
          name,
          bio: "",
          visibility: "everyone",
          password:
            salt + ":" + (await scrypt(password, salt, 64)).toString("hex"),
          createdAt: new Date().toISOString(),
        };
        db.users.push(user);
        await save();
        const sid = createSession(user.id);
        await save();
        return send(
          res,
          201,
          { user: safeUser(user) },
          { "set-cookie": cookieFor(req, sid) },
        );
      }
      if (p === "/api/auth/login" && method === "POST") {
        const u = db.users.find(
          (x) =>
            x.username ===
            String(data.username || "")
              .trim()
              .toLowerCase(),
        );
        let ok = false;
        if (u?.password?.includes(":")) {
          const [salt, expected] = u.password.split(":");
          const actual = await scrypt(String(data.password || ""), salt, 64);
          ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), actual);
        }
        if (!ok)
          throw Object.assign(new Error("Username or password is incorrect."), {
            status: 401,
          });
        const sid = createSession(u.id);
        await save();
        return send(
          res,
          200,
          { user: safeUser(u) },
          { "set-cookie": cookieFor(req, sid) },
        );
      }
      if (p === "/api/auth/logout" && method === "POST") {
        const sid = (req.headers.cookie || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("sn_session="))
          ?.slice(11);
        if (sid) {
          const hash = sessionTokenHash(sid);
          db.authSessions = db.authSessions.filter((s) => s.tokenHash !== hash);
          await save();
        }
        return send(
          res,
          200,
          { ok: true },
          {
            "set-cookie":
              "sn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
          },
        );
      }
      const user = auth(req);
      if (p === "/api/me" && method === "GET") {
        const active = activeSessionFor(user.id);
        const friends = getFriendsList(user.id);
        const incomingCount = db.friendRequests.filter(
          (r) => r.to === user.id && r.status === "pending",
        ).length;
        const incomingInvitesCount = (db.roomInvites || []).filter(
          (inv) => inv.targetUserId === user.id && inv.status === "pending",
        ).length;
        return send(res, 200, {
          user: safeUser(user),
          friends: friends.map((f) => f.id),
          friendsUsers: friends,
          friendsCount: friends.length,
          incomingRequestsCount: incomingCount,
          incomingInvitesCount,
          following: friends.map((f) => f.id),
          followingUsers: friends,
          followers: friends.length,
          activity:
            active && active.audience !== "off"
              ? {
                  sessionId: active.id,
                  videoId: active.videoId,
                  title: active.title,
                  playback: active.playback,
                  audience: active.audience,
                }
              : null,
        });
      }
      if (p === "/api/profile" && method === "PATCH") {
        if (data.name !== undefined) {
          const n = String(data.name).trim();
          if (!n || n.length > 50)
            throw Object.assign(
              new Error("Display name must be 1–50 characters."),
              { status: 400 },
            );
          user.name = n;
        }
        if (data.bio !== undefined) {
          if (String(data.bio).length > 180)
            throw Object.assign(
              new Error("Bio must be 180 characters or fewer."),
              { status: 400 },
            );
          user.bio = String(data.bio);
        }
        if (data.visibility !== undefined) {
          if (!["everyone", "followers", "nobody"].includes(data.visibility))
            throw Object.assign(
              new Error("Choose a valid visibility setting."),
              { status: 400 },
            );
          user.visibility = data.visibility;
        }
        await save();
        return send(res, 200, { user: safeUser(user) });
      }
      if (p === "/api/corner" && method === "GET") {
        expireSessions();
        const c = user.corner || {
          videoId: null,
          title: "",
          playback: "paused",
          position: 0,
          updatedAt: Date.now(),
          queue: [],
        };
        const cornerRoom = ensureCornerRoom(user, c);
        const hostRoomIds = new Set(
          db.rooms
            .filter(
              (rm) =>
                rm.ownerId === user.id &&
                (rm.status || "active") === "active",
            )
            .map((rm) => rm.id),
        );
        const pendingJoinRequests = (db.roomJoinRequests || [])
          .filter((jr) => hostRoomIds.has(jr.roomId) && jr.status === "pending")
          .map((jr) => {
            const u = db.users.find((x) => x.id === jr.userId);
            const rm = db.rooms.find((x) => x.id === jr.roomId);
            return {
              id: jr.id,
              roomId: jr.roomId,
              roomName: rm?.name || "Private Room",
              userId: jr.userId,
              userName: u?.name || jr.userName || "User",
              userUsername: u?.username || "",
              userHandle: u?.username || "",
              createdAt: jr.createdAt,
            };
          });
        return send(res, 200, {
          corner: c,
          cornerRoom: cornerRoom ? roomView(cornerRoom, user) : null,
          cornerJoinRequests: pendingJoinRequests,
          session: activeSessionFor(user.id),
          closeFriends: db.closeFriends
            .filter((f) => f.hostId === user.id)
            .map((f) => f.userId),
        });
      }
      if (p === "/api/corner" && method === "PUT") {
        const videoId = String(data.videoId || "").trim();
        if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId))
          throw Object.assign(new Error("Enter a valid YouTube video ID."), {
            status: 400,
          });
        user.corner = {
          ...(user.corner || {}),
          videoId: videoId || null,
          title: String(data.title || "")
            .trim()
            .slice(0, 100),
          updatedAt: Date.now(),
          position: 0,
          playback: "paused",
          queue: user.corner?.queue || [],
        };
        if (videoId && !user.corner.queue.some((q) => q.videoId === videoId))
          user.corner.queue.push({
            id: random(8),
            videoId,
            title: user.corner.title || `YouTube video ${videoId}`,
          });
        const s = activeSessionFor(user.id);
        if (s && videoId) {
          s.videoId = videoId;
          s.title = user.corner.title;
          s.position = 0;
          s.updatedAt = Date.now();
          s.playback = "paused";
        }
        const cornerRoom = ensureCornerRoom(user, user.corner);
        await save();
        return send(res, 200, {
          corner: user.corner,
          cornerRoom: cornerRoom ? roomView(cornerRoom, user) : null,
        });
      }
      if (p === "/api/corner/queue" && method === "POST") {
        const videoId = String(data.videoId || "").trim();
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
          throw Object.assign(new Error("Enter a valid YouTube video ID."), {
            status: 400,
          });
        const c =
          user.corner ||
          (user.corner = {
            videoId: null,
            title: "",
            playback: "paused",
            position: 0,
            updatedAt: Date.now(),
            queue: [],
          });
        c.queue = c.queue || [];
        const item = {
          id: random(8),
          videoId,
          title:
            String(data.title || "")
              .trim()
              .slice(0, 100) || `YouTube video ${videoId}`,
        };
        c.queue.push(item);
        if (!c.videoId) {
          c.videoId = videoId;
          c.title = item.title;
          c.position = 0;
          c.playback = "paused";
        }
        c.updatedAt = Date.now();
        const cornerRoom = ensureCornerRoom(user, c);
        await save();
        return send(res, 201, {
          corner: c,
          cornerRoom: cornerRoom ? roomView(cornerRoom, user) : null,
        });
      }
      if (p === "/api/corner/next" && method === "POST") {
        const c = user.corner || {};
        const queue = c.queue || [];
        if (!queue.length)
          throw Object.assign(new Error("Add a video to your queue first."), {
            status: 400,
          });
        const index = queue.findIndex((q) => q.videoId === c.videoId);
        const next = queue[(index + 1 + queue.length) % queue.length];
        c.videoId = next.videoId;
        c.title = next.title;
        c.position = 0;
        c.playback = "playing";
        c.updatedAt = Date.now();
        user.corner = c;
        const s = activeSessionFor(user.id);
        if (s) {
          s.videoId = c.videoId;
          s.title = c.title;
          s.position = 0;
          s.playback = "playing";
          s.updatedAt = c.updatedAt;
          s.hostSeenAt = Date.now();
        }
        const cornerRoom = ensureCornerRoom(user, c);
        await save();
        return send(res, 200, {
          corner: c,
          cornerRoom: cornerRoom ? roomView(cornerRoom, user) : null,
        });
      }
      if (p === "/api/corner/play" && method === "POST") {
        const c =
          user.corner ||
          (user.corner = {
            videoId: null,
            title: "",
            playback: "paused",
            position: 0,
          });
        if (data.status !== undefined) {
          if (!["playing", "paused"].includes(data.status))
            throw Object.assign(
              new Error("Playback state must be playing or paused."),
              { status: 400 },
            );
          c.playback = data.status;
        }
        if (data.position !== undefined) {
          const position = Number(data.position);
          if (!Number.isFinite(position) || position < 0 || position > 86400)
            throw Object.assign(new Error("Invalid playback position."), {
              status: 400,
            });
          c.position = position;
        }
        c.updatedAt = Date.now();
        const s = activeSessionFor(user.id);
        if (s) {
          s.videoId = c.videoId;
          s.title = c.title;
          s.playback = c.playback;
          s.position = c.position;
          s.updatedAt = c.updatedAt;
          s.hostSeenAt = Date.now();
        }
        const cornerRoom = ensureCornerRoom(user, c);
        await save();
        return send(res, 200, {
          corner: c,
          cornerRoom: cornerRoom ? roomView(cornerRoom, user) : null,
          session: s ? sessionView(s, user) : null,
        });
      }
      if (p === "/api/share" && method === "POST") {
        const audience = String(data.audience || "off");
        if (
          !["everyone", "followers", "close-friends", "off"].includes(audience)
        )
          throw Object.assign(new Error("Choose a valid sharing audience."), {
            status: 400,
          });
        const c = user.corner || {};
        if (audience !== "off" && !c.videoId)
          throw Object.assign(
            new Error("Load a YouTube video in Your Corner before sharing."),
            { status: 400 },
          );
        let s = activeSessionFor(user.id);
        if (!s && audience !== "off") {
          s = {
            id: random(12),
            hostId: user.id,
            videoId: c.videoId,
            title: c.title || "",
            playback: c.playback || "paused",
            position: Number(c.position) || 0,
            updatedAt: Date.now(),
            hostSeenAt: Date.now(),
            audience,
            status: "active",
            participants: [],
            createdAt: Date.now(),
          };
          db.sessions.push(s);
        }
        if (s) {
          s.audience = audience;
          s.updatedAt = Date.now();
          s.hostSeenAt = Date.now();
        }
        user.shareAudience = audience;
        await save();
        return send(res, 200, {
          audience,
          session: s ? { id: s.id, status: s.status } : null,
        });
      }
      if (p === "/api/close-friends" && method === "GET")
        return send(res, 200, {
          people: db.users
            .filter(
              (u) =>
                areFriends(user.id, u.id) ||
                db.follows.some((f) => f.from === user.id && f.to === u.id),
            )
            .map((u) => ({
              ...safeUser(u),
              selected: db.closeFriends.some(
                (f) => f.hostId === user.id && f.userId === u.id,
              ),
            })),
        });
      if (p === "/api/close-friends" && method === "PUT") {
        if (!Array.isArray(data.userIds) || data.userIds.length > 200)
          throw Object.assign(
            new Error("Provide a valid close friends list."),
            { status: 400 },
          );
        const ids = [...new Set(data.userIds.map(String))];
        if (
          ids.some(
            (id) =>
              id === user.id ||
              !(
                areFriends(user.id, id) ||
                db.follows.some((f) => f.from === user.id && f.to === id)
              ),
          )
        )
          throw Object.assign(
            new Error("Close Friends can only include accounts you have friended or followed."),
            { status: 403 },
          );
        db.closeFriends = db.closeFriends.filter((f) => f.hostId !== user.id);
        for (const userId of ids)
          db.closeFriends.push({ hostId: user.id, userId });
        await save();
        return send(res, 200, { userIds: ids });
      }
      if (p === "/api/peoples" && method === "GET") {
        expireSessions();
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        let searchResults = null;
        if (q) {
          const matched = db.users
            .filter(
              (u) =>
                u.id !== user.id &&
                (u.username.toLowerCase().includes(q) ||
                  (u.name && u.name.toLowerCase().includes(q))),
            )
            .slice(0, 20);
          searchResults = matched.map((person) =>
            formatPersonForViewer(person, user),
          );
        }

        // Limit recommendations to 10-20 accounts not yet friended or requested
        const eligible = db.users.filter(
          (u) => u.id !== user.id && getFriendshipStatus(user.id, u.id) === "none",
        );
        const recommendations = eligible
          .slice(0, 15)
          .map((person) => formatPersonForViewer(person, user));

        // Mutual friends
        const friendIds = new Set();
        for (const r of db.friendRequests) {
          if (r.status === "accepted") {
            if (r.from === user.id) friendIds.add(r.to);
            else if (r.to === user.id) friendIds.add(r.from);
          }
        }
        const friends = db.users
          .filter((u) => friendIds.has(u.id))
          .map((person) => formatPersonForViewer(person, user));

        // Pending incoming and outgoing requests
        const incomingRequests = db.friendRequests
          .filter((r) => r.to === user.id && r.status === "pending")
          .map((r) => {
            const requester = db.users.find((u) => u.id === r.from);
            return requester
              ? {
                  requestId: r.id,
                  createdAt: r.createdAt,
                  user: formatPersonForViewer(requester, user),
                }
              : null;
          })
          .filter(Boolean);

        const outgoingRequests = db.friendRequests
          .filter((r) => r.from === user.id && r.status === "pending")
          .map((r) => {
            const target = db.users.find((u) => u.id === r.to);
            return target
              ? {
                  requestId: r.id,
                  createdAt: r.createdAt,
                  user: formatPersonForViewer(target, user),
                }
              : null;
          })
          .filter(Boolean);

        const people = searchResults || recommendations;
        return send(res, 200, {
          people,
          recommendations,
          searchResults,
          friends,
          incomingRequests,
          outgoingRequests,
          query: q,
        });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/join$/)) &&
        method === "POST"
      ) {
        expireSessions();
        const s = db.sessions.find((x) => x.id === m[1]);
        if (
          !s ||
          s.status !== "active" ||
          s.audience === "off" ||
          !audienceAllows(s, user)
        )
          throw Object.assign(
            new Error("This listening session is unavailable to you."),
            { status: 403 },
          );
        if (s.hostId === user.id)
          throw Object.assign(
            new Error("You are already hosting this session."),
            { status: 400 },
          );
        const oldId = db.listenerSessions.find(
          (x) => x.userId === user.id,
        )?.sessionId;
        if (oldId) {
          const old = db.sessions.find((x) => x.id === oldId);
          if (old)
            old.participants = old.participants.filter((id) => id !== user.id);
          db.listenerSessions = db.listenerSessions.filter(
            (x) => x.userId !== user.id,
          );
        }
        if (!s.participants.includes(user.id)) s.participants.push(user.id);
        db.listenerSessions.push({
          userId: user.id,
          sessionId: s.id,
          joinedAt: Date.now(),
          lastSeenAt: Date.now(),
        });
        await save();
        return send(res, 200, { session: sessionView(s, user) });
      }
      if ((m = p.match(/^\/api\/sessions\/([^/]+)$/)) && method === "GET") {
        expireSessions();
        const s = db.sessions.find((x) => x.id === m[1]);
        return send(res, 200, { session: sessionView(s, user) });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/)) &&
        method === "POST"
      ) {
        expireSessions();
        const s = db.sessions.find((x) => x.id === m[1]);
        if (!sessionCanView(s, user))
          throw Object.assign(new Error("Session not found."), { status: 404 });
        if (s.hostId === user.id) {
          s.hostSeenAt = Date.now();
          const c = user.corner || {};
          s.videoId = c.videoId;
          s.title = c.title;
          s.playback = c.playback || "paused";
          s.position = Number(c.position) || 0;
          s.updatedAt = Number(c.updatedAt) || Date.now();
        } else {
          const lm = db.listenerSessions.find(
            (x) => x.userId === user.id && x.sessionId === s.id,
          );
          if (!lm)
            throw Object.assign(new Error("You have left this session."), {
              status: 403,
            });
          lm.lastSeenAt = Date.now();
        }
        await save();
        return send(res, 200, { session: sessionView(s, user) });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/leave$/)) &&
        method === "POST"
      ) {
        const s = db.sessions.find((x) => x.id === m[1]);
        if (!sessionCanView(s, user) || s.hostId === user.id)
          throw Object.assign(new Error("Session not found."), { status: 404 });
        s.participants = s.participants.filter((id) => id !== user.id);
        db.listenerSessions = db.listenerSessions.filter(
          (x) => !(x.userId === user.id && x.sessionId === s.id),
        );
        await save();
        return send(res, 200, { ok: true });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/play$/)) &&
        method === "POST"
      ) {
        const s = db.sessions.find((x) => x.id === m[1]);
        if (
          !sessionCanView(s, user) ||
          s.hostId !== user.id ||
          s.status !== "active"
        )
          throw Object.assign(
            new Error("Only the active host can control shared playback."),
            { status: 403 },
          );
        const c = user.corner || {};
        if (data.status !== undefined) {
          if (!["playing", "paused"].includes(data.status))
            throw Object.assign(new Error("Invalid playback state."), {
              status: 400,
            });
          c.playback = data.status;
        }
        if (data.position !== undefined) {
          const position = Number(data.position);
          if (!Number.isFinite(position) || position < 0 || position > 86400)
            throw Object.assign(new Error("Invalid playback position."), {
              status: 400,
            });
          c.position = position;
        }
        c.updatedAt = Date.now();
        user.corner = c;
        s.videoId = c.videoId;
        s.title = c.title;
        s.playback = c.playback;
        s.position = c.position;
        s.updatedAt = c.updatedAt;
        s.hostSeenAt = Date.now();
        await save();
        return send(res, 200, { session: sessionView(s, user) });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/requests$/)) &&
        ["GET", "POST"].includes(method)
      ) {
        const s = db.sessions.find((x) => x.id === m[1]);
        if (!s || !sessionCanView(s, user))
          throw Object.assign(new Error("Session not found."), { status: 404 });
        if (method === "GET") {
          if (s.hostId !== user.id && !(s.participants || []).includes(user.id))
            throw Object.assign(
              new Error("Session requests are unavailable."),
              { status: 403 },
            );
          const requests = db.sessionRequests
            .filter(
              (x) =>
                x.sessionId === s.id &&
                (s.hostId === user.id || x.requesterId === user.id),
            )
            .map((x) => ({
              ...x,
              requester: safeUser(db.users.find((u) => u.id === x.requesterId)),
            }));
          return send(res, 200, { requests });
        }
        if (
          s.status !== "active" ||
          s.hostId === user.id ||
          !(s.participants || []).includes(user.id)
        )
          throw Object.assign(
            new Error("Only current listeners can request songs."),
            { status: 403 },
          );
        const videoId = String(data.videoId || "").trim();
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
          throw Object.assign(new Error("Enter a valid YouTube video ID."), {
            status: 400,
          });
        const duplicate = db.sessionRequests.find(
          (x) =>
            x.sessionId === s.id &&
            x.requesterId === user.id &&
            x.videoId === videoId &&
            x.status === "pending",
        );
        if (duplicate)
          return send(res, 200, { request: duplicate, duplicate: true });
        const request = {
          id: random(10),
          sessionId: s.id,
          hostId: s.hostId,
          requesterId: user.id,
          videoId,
          title:
            String(data.title || "")
              .trim()
              .slice(0, 100) || `YouTube video ${videoId}`,
          status: "pending",
          createdAt: new Date().toISOString(),
          queueItemId: null,
        };
        db.sessionRequests.push(request);
        await save();
        return send(res, 201, { request });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/requests\/([^/]+)$/)) &&
        method === "POST"
      ) {
        const s = db.sessions.find((x) => x.id === m[1]),
          request = db.sessionRequests.find(
            (x) => x.id === m[2] && x.sessionId === m[1],
          );
        if (!s || !request)
          throw Object.assign(new Error("Song request not found."), {
            status: 404,
          });
        if (s.hostId !== user.id)
          throw Object.assign(
            new Error("Only the session host can review song requests."),
            { status: 403 },
          );
        const decision = String(data.status || "");
        if (!["approved", "rejected"].includes(decision))
          throw Object.assign(new Error("Choose approve or reject."), {
            status: 400,
          });
        if (request.status === decision)
          return send(res, 200, { request, queue: user.corner?.queue || [] });
        if (request.status !== "pending")
          throw Object.assign(
            new Error("This request has already been reviewed."),
            { status: 409 },
          );
        if (s.status !== "active")
          throw Object.assign(
            new Error(
              "This session has ended; its requests cannot be approved.",
            ),
            { status: 410 },
          );
        request.status = decision;
        request.reviewedAt = new Date().toISOString();
        if (decision === "approved") {
          const c =
            user.corner ||
            (user.corner = {
              videoId: s.videoId,
              title: s.title,
              playback: s.playback,
              position: s.position,
              updatedAt: Date.now(),
              queue: [],
            });
          c.queue = c.queue || [];
          let item = c.queue.find((q) => q.videoId === request.videoId);
          if (!item) {
            item = {
              id: random(8),
              videoId: request.videoId,
              title: request.title,
            };
            c.queue.push(item);
          }
          request.queueItemId = item.id;
          request.addedToQueue = true;
        }
        await save();
        return send(res, 200, { request, queue: user.corner?.queue || [] });
      }
      if (
        (m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)) &&
        ["GET", "POST"].includes(method)
      ) {
        const s = db.sessions.find((x) => x.id === m[1]);
        if (
          !sessionCanView(s, user) ||
          !((s.participants || []).includes(user.id) || s.hostId === user.id)
        )
          throw Object.assign(new Error("Session chat is unavailable."), {
            status: 403,
          });
        if (method === "GET")
          return send(res, 200, {
            messages: db.sessionMessages
              .filter((x) => x.sessionId === s.id)
              .slice(-100),
          });
        if (s.status !== "active")
          throw Object.assign(
            new Error(
              "This session chat is read-only because the host has left.",
            ),
            { status: 410 },
          );
        const text = String(data.text || "").trim();
        if (!text || text.length > 500)
          throw Object.assign(new Error("Message must be 1–500 characters."), {
            status: 400,
          });
        const msg = {
          id: random(8),
          sessionId: s.id,
          user: safeUser(user),
          text,
          createdAt: new Date().toISOString(),
        };
        db.sessionMessages.push(msg);
        await save();
        return send(res, 201, { message: msg });
      }
      if (p === "/api/corner/end" && method === "POST") {
        const s = activeSessionFor(user.id);
        if (s) {
          s.status = "ended";
          s.endedAt = Date.now();
          s.audience = "off";
          s.updatedAt = Date.now();
        }
        user.shareAudience = "off";
        await save();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/people" && method === "GET") {
        const eligible = db.users.filter(
          (u) => u.id !== user.id && getFriendshipStatus(user.id, u.id) === "none",
        );
        const recommendations = eligible
          .slice(0, 15)
          .map((u) => formatPersonForViewer(u, user));
        return send(res, 200, {
          people: recommendations,
          recommendations,
        });
      }
      if ((m = p.match(/^\/api\/people\/([^/]+)$/)) && method === "GET") {
        const u = db.users.find((x) => x.username === m[1] || x.id === m[1]);
        if (!u)
          throw Object.assign(new Error("Profile not found."), { status: 404 });
        const active = activeSessionFor(u.id),
          visible =
            active &&
            active.audience !== "off" &&
            (u.id === user.id || audienceAllows(active, user));
        const activity = visible
          ? {
              sessionId: active.id,
              videoId: active.videoId,
              title: active.title,
              playback: active.playback,
              audience: active.audience,
              participants: (active.participants || []).length,
            }
          : null;
        const friendshipStatus = getFriendshipStatus(user.id, u.id);
        const reqItem = db.friendRequests.find(
          (r) =>
            (r.from === user.id && r.to === u.id) ||
            (r.from === u.id && r.to === user.id),
        );
        const friends = getFriendsList(u.id);
        const formatted = formatPersonForViewer(u, user);
        return send(res, 200, {
          user: safeUser(u),
          friendshipStatus,
          requestId: reqItem?.id || null,
          following: friendshipStatus === "friends",
          friendsCount: friends.length,
          friends,
          followingUsers: friends,
          activity,
          cornerRoom: formatted.cornerRoom,
        });
      }
      if (
        (m = p.match(/^\/api\/people\/([^/]+)\/follow$/)) &&
        method === "POST"
      ) {
        const to = db.users.find((u) => u.id === m[1] || u.username === m[1]);
        if (!to)
          throw Object.assign(new Error("Account not found."), { status: 404 });
        if (to.id === user.id)
          throw Object.assign(new Error("You cannot add yourself."), {
            status: 400,
          });
        const status = getFriendshipStatus(user.id, to.id);
        let following = false;
        let newStatus = "none";
        if (status === "friends") {
          db.friendRequests = db.friendRequests.filter(
            (r) =>
              !(
                (r.from === user.id && r.to === to.id) ||
                (r.from === to.id && r.to === user.id)
              ),
          );
          db.closeFriends = db.closeFriends.filter(
            (f) => !(f.hostId === user.id && f.userId === to.id),
          );
          db.follows = db.follows.filter(
            (f) => !(f.from === user.id && f.to === to.id),
          );
          following = false;
          newStatus = "none";
        } else if (status === "outgoing_pending") {
          db.friendRequests = db.friendRequests.filter(
            (r) => !(r.from === user.id && r.to === to.id),
          );
          following = false;
          newStatus = "none";
        } else if (status === "incoming_pending") {
          const reqItem = db.friendRequests.find(
            (r) => r.from === to.id && r.to === user.id,
          );
          if (reqItem) {
            reqItem.status = "accepted";
            reqItem.acceptedAt = Date.now();
          }
          following = true;
          newStatus = "friends";
        } else {
          db.friendRequests.push({
            id: random(),
            from: user.id,
            to: to.id,
            status: "pending",
            createdAt: Date.now(),
          });
          following = false;
          newStatus = "outgoing_pending";
        }
        await save();
        return send(res, 200, {
          following,
          friendshipStatus: newStatus,
          userId: to.id,
        });
      }
      if (p === "/api/friends" && method === "GET") {
        const friends = getFriendsList(user.id);
        const incomingRequests = db.friendRequests
          .filter((r) => r.to === user.id && r.status === "pending")
          .map((r) => {
            const requester = db.users.find((u) => u.id === r.from);
            return requester
              ? {
                  requestId: r.id,
                  createdAt: r.createdAt,
                  user: formatPersonForViewer(requester, user),
                }
              : null;
          })
          .filter(Boolean);
        const outgoingRequests = db.friendRequests
          .filter((r) => r.from === user.id && r.status === "pending")
          .map((r) => {
            const target = db.users.find((u) => u.id === r.to);
            return target
              ? {
                  requestId: r.id,
                  createdAt: r.createdAt,
                  user: formatPersonForViewer(target, user),
                }
              : null;
          })
          .filter(Boolean);
        return send(res, 200, {
          friends,
          incomingRequests,
          outgoingRequests,
        });
      }
      if (p === "/api/friends/request" && method === "POST") {
        const targetId = String(data.targetId || data.userId || "");
        const target = db.users.find(
          (u) => u.id === targetId || u.username === targetId,
        );
        if (!target)
          throw Object.assign(new Error("User not found."), { status: 404 });
        if (target.id === user.id)
          throw Object.assign(new Error("You cannot friend yourself."), {
            status: 400,
          });
        const existing = db.friendRequests.find(
          (r) =>
            (r.from === user.id && r.to === target.id) ||
            (r.from === target.id && r.to === user.id),
        );
        if (existing) {
          if (existing.status === "accepted") {
            return send(res, 200, {
              ok: true,
              status: "friends",
              request: existing,
            });
          }
          if (existing.status === "pending") {
            if (existing.from === target.id) {
              existing.status = "accepted";
              existing.acceptedAt = Date.now();
              await save();
              return send(res, 200, {
                ok: true,
                status: "friends",
                request: existing,
              });
            }
            return send(res, 200, {
              ok: true,
              status: "outgoing_pending",
              request: existing,
            });
          }
          existing.status = "pending";
          existing.from = user.id;
          existing.to = target.id;
          existing.createdAt = Date.now();
          await save();
          return send(res, 200, {
            ok: true,
            status: "outgoing_pending",
            request: existing,
          });
        }
        const reqItem = {
          id: random(),
          from: user.id,
          to: target.id,
          status: "pending",
          createdAt: Date.now(),
        };
        db.friendRequests.push(reqItem);
        await save();
        return send(res, 201, {
          ok: true,
          status: "outgoing_pending",
          request: reqItem,
        });
      }
      if (p === "/api/friends/accept" && method === "POST") {
        const reqId = String(data.requestId || "");
        const userId = String(data.userId || "");
        const reqItem = db.friendRequests.find(
          (r) =>
            (reqId && r.id === reqId) ||
            (userId && r.from === userId && r.to === user.id),
        );
        if (!reqItem || reqItem.to !== user.id)
          throw Object.assign(new Error("Friend request not found."), {
            status: 404,
          });
        reqItem.status = "accepted";
        reqItem.acceptedAt = Date.now();
        await save();
        return send(res, 200, { ok: true, status: "friends", request: reqItem });
      }
      if (p === "/api/friends/decline" && method === "POST") {
        const reqId = String(data.requestId || "");
        const userId = String(data.userId || "");
        const idx = db.friendRequests.findIndex(
          (r) =>
            (reqId && r.id === reqId) ||
            (userId && r.from === userId && r.to === user.id),
        );
        if (idx >= 0) {
          db.friendRequests.splice(idx, 1);
          await save();
        }
        return send(res, 200, { ok: true, status: "none" });
      }
      if (p === "/api/friends/cancel" && method === "POST") {
        const reqId = String(data.requestId || "");
        const targetId = String(data.targetId || data.userId || "");
        const idx = db.friendRequests.findIndex(
          (r) =>
            (reqId && r.id === reqId && r.from === user.id) ||
            (targetId && r.from === user.id && r.to === targetId),
        );
        if (idx >= 0) {
          db.friendRequests.splice(idx, 1);
          await save();
        }
        return send(res, 200, { ok: true, status: "none" });
      }
      if (p === "/api/friends/remove" && method === "POST") {
        const targetId = String(data.targetId || data.userId || "");
        db.friendRequests = db.friendRequests.filter(
          (r) =>
            !(
              (r.from === user.id && r.to === targetId) ||
              (r.from === targetId && r.to === user.id)
            ),
        );
        db.closeFriends = db.closeFriends.filter(
          (f) =>
            !(
              (f.hostId === user.id && f.userId === targetId) ||
              (f.hostId === targetId && f.userId === user.id)
            ),
        );
        await save();
        return send(res, 200, { ok: true, status: "none" });
      }
      if (p === "/api/rooms" && method === "GET") {
        const hostRoomIds = new Set(
          db.rooms
            .filter(
              (rm) =>
                rm.ownerId === user.id &&
                (rm.status || "active") === "active",
            )
            .map((rm) => rm.id),
        );
        const hostJoinRequests = (db.roomJoinRequests || [])
          .filter((jr) => hostRoomIds.has(jr.roomId) && jr.status === "pending")
          .map((jr) => {
            const u = db.users.find((x) => x.id === jr.userId);
            const rm = db.rooms.find((x) => x.id === jr.roomId);
            return {
              id: jr.id,
              roomId: jr.roomId,
              roomName: rm?.name || "Private Room",
              userId: jr.userId,
              userName: u?.name || jr.userName || "User",
              userUsername: u?.username || "",
              userHandle: u?.username || "",
              createdAt: jr.createdAt,
            };
          });
        return send(res, 200, {
          hostJoinRequests,
          rooms: db.rooms
            .filter((r) => {
              if (!r.isPrivate) return true;
              if (member(r.id, user.id)) return true;
              return (
                areFriends(r.ownerId, user.id) ||
                db.members.some(
                  (m) => m.roomId === r.id && areFriends(m.userId, user.id),
                )
              );
            })
            .map((r) => {
              const hostUser = db.users.find((u) => u.id === r.ownerId);
              const friendMember = db.members
                .filter((m) => m.roomId === r.id && areFriends(m.userId, user.id))
                .map((m) => db.users.find((u) => u.id === m.userId)?.name)
                .filter(Boolean)[0];
              return {
                id: r.id,
                name: r.name,
                isPrivate: !!r.isPrivate,
                isCornerRoom: !!r.isCornerRoom,
                hostName: hostUser?.name || "Host",
                hostUsername: hostUser?.username || "",
                friendMemberName: friendMember || null,
                status: r.status || "active",
                isHost: member(r.id, user.id)?.role === "host",
                isMember: !!member(r.id, user.id),
                hasRequestedJoin: (db.roomJoinRequests || []).some(
                  (jr) =>
                    jr.roomId === r.id &&
                    jr.userId === user.id &&
                    jr.status === "pending",
                ),
                members: db.members.filter((m) => m.roomId === r.id).length,
                track:
                  db.queue.find((q) => q.id === r.currentQueueId)?.title || null,
              };
            }),
        });
      }
      if (p === "/api/rooms" && method === "POST") {
        const name = String(data.name || "").trim();
        if (!name || name.length > 60)
          throw Object.assign(new Error("Room name must be 1–60 characters."), {
            status: 400,
          });
        const r = {
          id: random(12),
          name,
          isPrivate: !!data.isPrivate,
          ownerId: user.id,
          code: random(6).toUpperCase().slice(0, 8),
          createdAt: new Date().toISOString(),
          status: "active",
          playback: "paused",
        };
        db.rooms.push(r);
        db.members.push({ roomId: r.id, userId: user.id, role: "host" });
        await save();
        return send(res, 201, {
          room: roomView(r, user),
          inviteCode: r.isPrivate ? r.code : null,
        });
      }
      if (p === "/api/rooms/join" && method === "POST") {
        const code = String(data.code || "")
          .trim()
          .toUpperCase();
        const roomId = String(data.roomId || "").trim();
        let r = null;
        if (code) {
          r = db.rooms.find((x) => x.code === code);
        } else if (roomId) {
          r = db.rooms.find((x) => x.id === roomId);
        }
        if (!r)
          throw Object.assign(new Error("Room or invitation code is invalid."), {
            status: 404,
          });
        if ((r.status || "active") !== "active")
          throw Object.assign(
            new Error(
              "This room is closed. The host must start it before anyone can join.",
            ),
            { status: 409 },
          );
        if (r.isPrivate && !member(r.id, user.id)) {
          const hasApprovedRequest = (db.roomJoinRequests || []).some(
            (jr) =>
              jr.roomId === r.id &&
              jr.userId === user.id &&
              jr.status === "approved",
          );
          const hasInvite = (db.roomInvites || []).some(
            (inv) => inv.roomId === r.id && inv.toUserId === user.id,
          );
          if (r.code !== code && !hasApprovedRequest && !hasInvite) {
            throw Object.assign(
              new Error(
                "This is a private room. Please request to join or enter the invitation code.",
              ),
              { status: 403 },
            );
          }
        }
        if (!member(r.id, user.id))
          db.members.push({ roomId: r.id, userId: user.id, role: "member" });
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/join-request$/)) &&
        method === "POST"
      ) {
        const r = roomFor(m[1]);
        if (!r || (r.status || "active") !== "active")
          throw Object.assign(new Error("Room is not available."), {
            status: 404,
          });
        if (member(r.id, user.id))
          return send(res, 200, {
            alreadyMember: true,
            room: roomView(r, user),
          });
        const existing = (db.roomJoinRequests || []).find(
          (jr) =>
            jr.roomId === r.id &&
            jr.userId === user.id &&
            jr.status === "pending",
        );
        if (existing)
          return send(res, 200, { request: existing, pending: true });
        const jr = {
          id: random(10),
          roomId: r.id,
          userId: user.id,
          userName: user.name,
          userUsername: user.username,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        db.roomJoinRequests.push(jr);
        await save();
        return send(res, 201, { request: jr, pending: true });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/join-request$/)) &&
        method === "DELETE"
      ) {
        const r = roomFor(m[1]);
        if (!r)
          throw Object.assign(new Error("Room not found."), { status: 404 });
        db.roomJoinRequests = (db.roomJoinRequests || []).filter(
          (jr) =>
            !(
              jr.roomId === r.id &&
              jr.userId === user.id &&
              jr.status === "pending"
            ),
        );
        await save();
        return send(res, 200, { ok: true });
      }
      if (
        (m = p.match(
          /^\/api\/rooms\/([^/]+)\/join-request\/([^/]+)\/approve$/,
        )) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can approve join requests."),
            { status: 403 },
          );
        const jr = (db.roomJoinRequests || []).find(
          (x) => x.id === m[2] && x.roomId === r.id,
        );
        if (!jr)
          throw Object.assign(new Error("Join request not found."), {
            status: 404,
          });
        jr.status = "approved";
        if (!member(r.id, jr.userId)) {
          db.members.push({ roomId: r.id, userId: jr.userId, role: "member" });
          const targetUser = db.users.find((u) => u.id === jr.userId);
          db.messages.push({
            id: random(10),
            roomId: r.id,
            user: { id: "system", name: "System" },
            text: `${targetUser?.name || "A new member"} joined the room.`,
            createdAt: new Date().toISOString(),
          });
        }
        await save();
        return send(res, 200, { ok: true, room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/join-request\/([^/]+)\/deny$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can deny join requests."),
            { status: 403 },
          );
        const jr = (db.roomJoinRequests || []).find(
          (x) => x.id === m[2] && x.roomId === r.id,
        );
        if (!jr)
          throw Object.assign(new Error("Join request not found."), {
            status: 404,
          });
        jr.status = "denied";
        await save();
        return send(res, 200, { ok: true, room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/invite-candidates$/)) &&
        method === "GET"
      ) {
        const r = requireActiveRoom(m[1], user);
        const friends = getFriendsList(user.id);
        const candidates = friends.map((f) => {
          const inRoom = !!member(r.id, f.id);
          const invited = (db.roomInvites || []).some(
            (inv) =>
              inv.roomId === r.id &&
              inv.toUserId === f.id &&
              inv.status === "pending",
          );
          return {
            ...f,
            inRoom,
            invited,
          };
        });
        return send(res, 200, { candidates, roomCode: r.code });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/invite$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        const targetUserId = String(data.targetUserId || "").trim();
        const targetUser = db.users.find((u) => u.id === targetUserId);
        if (!targetUser)
          throw Object.assign(new Error("User not found."), { status: 404 });
        if (member(r.id, targetUser.id))
          throw Object.assign(
            new Error("User is already a member of this room."),
            { status: 400 },
          );
        const existing = (db.roomInvites || []).find(
          (inv) =>
            inv.roomId === r.id &&
            inv.toUserId === targetUser.id &&
            inv.status === "pending",
        );
        if (existing) return send(res, 200, { invite: existing });
        const inv = {
          id: random(10),
          roomId: r.id,
          roomName: r.name,
          fromUserId: user.id,
          fromUserName: user.name,
          toUserId: targetUser.id,
          code: r.code,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        db.roomInvites.push(inv);
        await save();
        return send(res, 201, { invite: inv });
      }
      if (p === "/api/me/invites" && method === "GET") {
        const invites = (db.roomInvites || [])
          .filter((inv) => inv.toUserId === user.id && inv.status === "pending")
          .map((inv) => {
            const r = db.rooms.find((rm) => rm.id === inv.roomId);
            return {
              id: inv.id,
              roomId: inv.roomId,
              roomName: r?.name || inv.roomName || "Room",
              fromUserName: inv.fromUserName,
              createdAt: inv.createdAt,
              roomStatus: r?.status || "closed",
            };
          })
          .filter((inv) => inv.roomStatus === "active");
        return send(res, 200, { invites });
      }
      if (
        (m = p.match(/^\/api\/invites\/([^/]+)\/accept$/)) &&
        method === "POST"
      ) {
        const inv = (db.roomInvites || []).find(
          (x) => x.id === m[1] && x.toUserId === user.id,
        );
        if (!inv)
          throw Object.assign(new Error("Invitation not found."), {
            status: 404,
          });
        const r = roomFor(inv.roomId);
        if (!r || (r.status || "active") !== "active")
          throw Object.assign(
            new Error("Room is closed or no longer available."),
            { status: 410 },
          );
        inv.status = "accepted";
        if (!member(r.id, user.id)) {
          db.members.push({ roomId: r.id, userId: user.id, role: "member" });
          db.messages.push({
            id: random(10),
            roomId: r.id,
            user: { id: "system", name: "System" },
            text: `${user.name} joined via invitation from ${inv.fromUserName}.`,
            createdAt: new Date().toISOString(),
          });
        }
        await save();
        return send(res, 200, { ok: true, roomId: r.id });
      }
      if (
        (m = p.match(/^\/api\/invites\/([^/]+)\/decline$/)) &&
        method === "POST"
      ) {
        const inv = (db.roomInvites || []).find(
          (x) => x.id === m[1] && x.toUserId === user.id,
        );
        if (!inv)
          throw Object.assign(new Error("Invitation not found."), {
            status: 404,
          });
        inv.status = "declined";
        await save();
        return send(res, 200, { ok: true });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/status$/)) &&
        method === "POST"
      ) {
        const r = requireRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can close or start this room."),
            { status: 403 },
          );
        const status = String(data.status || "");
        if (!["active", "closed"].includes(status))
          throw Object.assign(
            new Error("Room status must be active or closed."),
            { status: 400 },
          );
        if (status === "closed" && (r.status || "active") === "active") {
          if (r.playback === "playing")
            r.playbackPosition =
              (Number(r.playbackPosition) || 0) +
              Math.max(
                0,
                (Date.now() - Number(r.playbackUpdatedAt || Date.now())) / 1000,
              );
          r.playback = "paused";
          r.playbackUpdatedAt = Date.now();
        }
        r.status = status;
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if ((m = p.match(/^\/api\/rooms\/([^/]+)$/)) && method === "GET") {
        const r = requireRoom(m[1], user);
        return send(res, 200, { room: roomView(r, user) });
      }
      if ((m = p.match(/^\/api\/rooms\/([^/]+)\/join$/)) && method === "POST") {
        const r = roomFor(m[1]);
        if (!r)
          throw Object.assign(new Error("Room not found."), { status: 404 });
        if (r.isPrivate)
          throw Object.assign(
            new Error("Private rooms require an invitation code."),
            { status: 403 },
          );
        if ((r.status || "active") !== "active")
          throw Object.assign(
            new Error(
              "This room is closed. The host must start it before anyone can join.",
            ),
            { status: 409 },
          );
        if (!member(r.id, user.id))
          db.members.push({ roomId: r.id, userId: user.id, role: "member" });
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/leave$/)) &&
        method === "POST"
      ) {
        const r = requireRoom(m[1], user);
        const role = member(r.id, user.id)?.role;
        if (role === "host" && (r.status || "active") === "closed") {
          await save();
          return send(res, 200, { ok: true, roomRetained: true });
        }
        const wasHost = role === "host";
        db.members = db.members.filter(
          (x) => !(x.roomId === r.id && x.userId === user.id),
        );
        if (!db.members.some((x) => x.roomId === r.id)) {
          if ((r.status || "active") === "active")
            db.rooms = db.rooms.filter((x) => x.id !== r.id);
        } else if (wasHost) {
          const successor = db.members.find((x) => x.roomId === r.id);
          successor.role = "host";
          r.ownerId = successor.userId;
        }
        await save();
        return send(res, 200, { ok: true });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/queue$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        const type = data.type === "playlist" ? "playlist" : "video";
        const id = String(
          type === "playlist" ? data.playlistId : data.videoId || "",
        ).trim();
        if (type === "video" && !/^[A-Za-z0-9_-]{11}$/.test(id))
          throw Object.assign(
            new Error(
              "Enter a valid YouTube video URL or 11-character video ID.",
            ),
            { status: 400 },
          );
        if (type === "playlist" && !/^[A-Za-z0-9_-]{10,100}$/.test(id))
          throw Object.assign(
            new Error("Enter a valid YouTube playlist URL or playlist ID."),
            { status: 400 },
          );
        const title =
          String(data.title || "")
            .trim()
            .slice(0, 100) ||
          (type === "playlist" ? "YouTube playlist" : `YouTube video ${id}`);
        const q = {
          id: random(10),
          roomId: r.id,
          type,
          videoId: type === "video" ? id : null,
          playlistId: type === "playlist" ? id : null,
          title,
          by: safeUser(user),
          createdAt: new Date().toISOString(),
        };
        db.queue.push(q);
        if (!r.currentQueueId) {
          r.currentQueueId = q.id;
          if (r.playback === "playing") recordRoomHistory(r);
        }
        await save();
        return send(res, 201, { room: roomView(r, user) });
      }
      if ((m = p.match(/^\/api\/rooms\/([^/]+)\/play$/)) && method === "POST") {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can change shared playback."),
            { status: 403 },
          );
        if (
          data.queueId !== undefined &&
          !db.queue.some((q) => q.id === data.queueId && q.roomId === r.id)
        )
          throw Object.assign(new Error("Track not found in this room."), {
            status: 404,
          });
        if (data.queueId !== undefined) {
          r.currentQueueId = data.queueId;
          r.playbackPosition = 0;
        }
        if (data.position !== undefined) {
          const position = Number(data.position);
          if (!Number.isFinite(position) || position < 0 || position > 86400)
            throw Object.assign(new Error("Invalid playback position."), {
              status: 400,
            });
          r.playbackPosition = position;
        }
        if (data.status !== undefined) {
          if (!["playing", "paused"].includes(data.status))
            throw Object.assign(
              new Error("Playback state must be playing or paused."),
              { status: 400 },
            );
          r.playback = data.status;
        }
        if (
          r.playback === "playing" ||
          data.status === "playing" ||
          (data.queueId !== undefined && r.playback === "playing")
        ) {
          recordRoomHistory(r);
        }
        r.playbackUpdatedAt = Date.now();
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if ((m = p.match(/^\/api\/rooms\/([^/]+)\/next$/)) && method === "POST") {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can change shared playback."),
            { status: 403 },
          );
        const roomQueue = db.queue.filter((q) => q.roomId === r.id);
        if (roomQueue.length === 0)
          throw Object.assign(new Error("Queue is empty."), { status: 400 });
        const currentIndex = roomQueue.findIndex((q) => q.id === r.currentQueueId);
        let nextTrack = null;
        if (currentIndex === -1) {
          nextTrack = roomQueue[0];
        } else if (currentIndex < roomQueue.length - 1) {
          nextTrack = roomQueue[currentIndex + 1];
        } else {
          throw Object.assign(new Error("Already at the end of the queue."), {
            status: 400,
          });
        }
        r.currentQueueId = nextTrack.id;
        r.playbackPosition = 0;
        r.playback = "playing";
        r.playbackUpdatedAt = Date.now();
        recordRoomHistory(r);
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/(?:prev|previous)$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the room host can change shared playback."),
            { status: 403 },
          );
        const roomQueue = db.queue.filter((q) => q.roomId === r.id);
        if (roomQueue.length === 0)
          throw Object.assign(new Error("Queue is empty."), { status: 400 });
        const currentIndex = roomQueue.findIndex((q) => q.id === r.currentQueueId);
        let prevTrack = null;
        if (currentIndex > 0) {
          prevTrack = roomQueue[currentIndex - 1];
        } else {
          throw Object.assign(new Error("Already at the start of the queue."), {
            status: 400,
          });
        }
        r.currentQueueId = prevTrack.id;
        r.playbackPosition = 0;
        r.playback = "playing";
        r.playbackUpdatedAt = Date.now();
        recordRoomHistory(r);
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/pause-request$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        const mRole = member(r.id, user.id)?.role;
        if (!mRole)
          throw Object.assign(new Error("You are not a member of this room."), {
            status: 403,
          });
        if (mRole === "host") {
          r.playback = "paused";
          r.playbackUpdatedAt = Date.now();
          await save();
          return send(res, 200, { ok: true, room: roomView(r, user) });
        }
        if (r.playback !== "playing") {
          throw Object.assign(new Error("Playback is already paused."), {
            status: 400,
          });
        }
        db.roomPauseRequests = db.roomPauseRequests || [];
        const existing = db.roomPauseRequests.find(
          (pr) =>
            pr.roomId === r.id &&
            pr.userId === user.id &&
            pr.status === "pending",
        );
        if (existing) {
          return send(res, 200, {
            ok: true,
            request: existing,
            room: roomView(r, user),
          });
        }
        const reqItem = {
          id: random(10),
          roomId: r.id,
          userId: user.id,
          status: "pending",
          createdAt: Date.now(),
        };
        db.roomPauseRequests.push(reqItem);
        db.messages.push({
          id: random(10),
          roomId: r.id,
          user: {
            id: "system",
            name: "System",
            username: "system",
            avatar: "",
          },
          text: `⏸ ${user.name} (@${user.username}) requested to pause the video.`,
          createdAt: new Date().toISOString(),
        });
        await save();
        return send(res, 201, {
          ok: true,
          request: reqItem,
          room: roomView(r, user),
        });
      }
      if (
        (m = p.match(
          /^\/api\/rooms\/([^/]+)\/pause-request\/([^/]+)\/approve$/,
        )) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the host can approve pause requests."),
            { status: 403 },
          );
        db.roomPauseRequests = db.roomPauseRequests || [];
        const reqItem = db.roomPauseRequests.find(
          (pr) =>
            pr.roomId === r.id && pr.id === m[2] && pr.status === "pending",
        );
        if (!reqItem)
          throw Object.assign(new Error("Pause request not found."), {
            status: 404,
          });
        reqItem.status = "approved";
        reqItem.resolvedAt = Date.now();
        r.playback = "paused";
        if (data.position !== undefined) {
          r.playbackPosition = Number(data.position) || r.playbackPosition;
        }
        r.playbackUpdatedAt = Date.now();
        const requester = db.users.find((u) => u.id === reqItem.userId);
        db.messages.push({
          id: random(10),
          roomId: r.id,
          user: {
            id: "system",
            name: "System",
            username: "system",
            avatar: "",
          },
          text: `⏸ Host approved pause request from ${requester?.name || "member"}. Playback paused.`,
          createdAt: new Date().toISOString(),
        });
        await save();
        return send(res, 200, { ok: true, room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/pause-request\/([^/]+)\/deny$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(
            new Error("Only the host can deny pause requests."),
            { status: 403 },
          );
        db.roomPauseRequests = db.roomPauseRequests || [];
        const reqItem = db.roomPauseRequests.find(
          (pr) =>
            pr.roomId === r.id && pr.id === m[2] && pr.status === "pending",
        );
        if (!reqItem)
          throw Object.assign(new Error("Pause request not found."), {
            status: 404,
          });
        reqItem.status = "denied";
        reqItem.resolvedAt = Date.now();
        const requester = db.users.find((u) => u.id === reqItem.userId);
        db.messages.push({
          id: random(10),
          roomId: r.id,
          user: {
            id: "system",
            name: "System",
            username: "system",
            avatar: "",
          },
          text: `▶ Host denied pause request from ${requester?.name || "member"}. Video continues playing.`,
          createdAt: new Date().toISOString(),
        });
        await save();
        return send(res, 200, { ok: true, room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/pause-request$/)) &&
        method === "DELETE"
      ) {
        const r = requireActiveRoom(m[1], user);
        db.roomPauseRequests = (db.roomPauseRequests || []).filter(
          (pr) =>
            !(
              pr.roomId === r.id &&
              pr.userId === user.id &&
              pr.status === "pending"
            ),
        );
        await save();
        return send(res, 200, { ok: true, room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/queue\/([^/]+)\/vote$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user),
          qid = m[2];
        if (!db.queue.some((q) => q.id === qid && q.roomId === r.id))
          throw Object.assign(new Error("Track not found."), { status: 404 });
        const value = Number(data.value);
        if (![-1, 0, 1].includes(value))
          throw Object.assign(new Error("Vote must be up, down, or removed."), {
            status: 400,
          });
        db.votes = db.votes.filter(
          (v) => !(v.queueId === qid && v.userId === user.id),
        );
        if (value) db.votes.push({ queueId: qid, userId: user.id, value });
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/queue\/([^/]+)$/)) &&
        method === "DELETE"
      ) {
        const r = requireActiveRoom(m[1], user);
        if (member(r.id, user.id)?.role !== "host")
          throw Object.assign(new Error("Only the host can remove tracks."), {
            status: 403,
          });
        const qid = m[2];
        db.queue = db.queue.filter((q) => q.id !== qid);
        db.votes = db.votes.filter((v) => v.queueId !== qid);
        if (r.currentQueueId === qid) {
          r.currentQueueId =
            db.queue.find((q) => q.roomId === r.id)?.id || null;
          r.playback = "paused";
        }
        await save();
        return send(res, 200, { room: roomView(r, user) });
      }
      if (
        (m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/)) &&
        method === "POST"
      ) {
        const r = requireActiveRoom(m[1], user),
          text = String(data.text || "").trim();
        if (!text || text.length > 500)
          throw Object.assign(new Error("Message must be 1–500 characters."), {
            status: 400,
          });
        const msg = {
          id: random(8),
          roomId: r.id,
          user: safeUser(user),
          text,
          createdAt: new Date().toISOString(),
        };
        db.messages.push(msg);
        await save();
        return send(res, 201, { message: msg });
      }
      throw Object.assign(new Error("Not found."), { status: 404 });
    }
    let file = p === "/" ? "index.html" : p.slice(1);
    file = path.resolve(ROOT, "public", file);
    if (!file.startsWith(path.resolve(ROOT, "public") + path.sep))
      return send(res, 403, { error: "Forbidden" });
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    fs.readFile(file, (e, b) => {
      if (e) return send(res, 404, { error: "Not found" });
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; img-src 'self' https: data:; connect-src 'self'",
      });
      res.end(b);
    });
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, { error: "Not found" });
    send(res, e.status || 500, {
      error: e.status ? e.message : "Something went wrong.",
    });
  }
}
function handleRequest(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/"))
    return withFreshDb(() => route(req, res), res);
  return route(req, res);
}

if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, "0.0.0.0", () =>
    console.log(`Sync & Share listening on http://localhost:${PORT}`),
  );
}

module.exports = handleRequest;
