const app = document.querySelector("#app");
let me = null,
  activeRoom = null,
  poll = null,
  toastTimer,
  ytPlayer = null,
  ytReady = false,
  ytVideoKey = "",
  syncGuard = false,
  lastSyncPost = 0,
  currentRoomTab = "queue";
function loadYouTubeApi() {
  if (window.YT?.Player) {
    ytReady = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      ytReady = true;
      resolve();
    };
    if (!document.querySelector("#youtube-iframe-api")) {
      const s = document.createElement("script");
      s.id = "youtube-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.head.append(s);
    }
  });
}
function startPlayer(r) {
  const q = r.nowPlaying;
  if (!q || q.type === "playlist") return;
  const key = q.videoId;
  if (!key) return;
  ytVideoKey = key;
  loadYouTubeApi().then(() => {
    if (!document.querySelector("#yt-player")) return;
    if (ytPlayer?.destroy) ytPlayer.destroy();
    ytPlayer = new YT.Player("yt-player", {
      videoId: key,
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => syncPlayer(r, true),
        onStateChange: (e) => {
          if (syncGuard) return;
          if (
            r.host &&
            (e.data === YT.PlayerState.PLAYING ||
              e.data === YT.PlayerState.PAUSED)
          ) {
            postPlayback(r.id, {
              status: e.data === YT.PlayerState.PLAYING ? "playing" : "paused",
              position: ytPlayer.getCurrentTime() || 0,
            });
          }
          if (r.host && e.data === YT.PlayerState.ENDED) {
            api(`/rooms/${r.id}/next`, { method: "POST" })
              .then(() => refreshRoom(r.id))
              .catch(() => {});
          }
        },
      },
    });
  });
}
async function postPlayback(id, data) {
  const now = Date.now();
  if (
    data.status === undefined &&
    data.position !== undefined &&
    now - lastSyncPost < 3000
  )
    return;
  lastSyncPost = now;
  try {
    await api(`/rooms/${id}/play`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  } catch {}
}
function syncPlayer(r, force = false) {
  if (!ytPlayer?.getCurrentTime || r.nowPlaying?.type === "playlist") return;
  const elapsed =
      r.playback === "playing"
        ? Math.max(0, (Date.now() - r.playbackUpdatedAt) / 1000)
        : 0,
    target = (r.playbackPosition || 0) + elapsed,
    current = ytPlayer.getCurrentTime() || 0;
  if (force || Math.abs(current - target) > 2) {
    syncGuard = true;
    try {
      if (force || Math.abs(current - target) > 4)
        ytPlayer.seekTo(target, true);
      if (r.playback === "playing") ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } catch {}
    setTimeout(() => (syncGuard = false), 500);
  }
  if (r.host && r.playback === "playing" && Date.now() - lastSyncPost > 5000)
    postPlayback(r.id, { position: current });
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function trackYoutubeUrl(x) {
  if (!x) return "";
  if (x.type === "playlist" && x.playlistId) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(x.playlistId)}`;
  }
  if (x.videoId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(x.videoId)}`;
  }
  return "";
}
function formatChatMessage(text) {
  const escaped = esc(text);
  return escaped.replace(
    /(https?:\/\/[^\s]+)/g,
    (url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url} ↗</a>`,
  );
}
async function api(path, opts = {}) {
  const r = await fetch("/api" + path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  let d = {};
  try {
    d = await r.json();
  } catch {}
  if (!r.ok) throw Error(d.error || `Request failed (${r.status})`);
  return d;
}
function toast(s) {
  const el = document.querySelector("#toast");
  el.textContent = s;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function avatar(u) {
  return u.avatar
    ? `<div class="avatar" style="background-image:url('${esc(u.avatar)}');background-size:cover;background-position:center" aria-label="${esc(u.name)}"></div>`
    : `<div class="avatar">${esc((u.name || u.username || "?").slice(0, 1).toUpperCase())}</div>`;
}
function nav(on = "home") {
  const reqBadge = me?.incomingRequestsCount
    ? `<span class="tab-badge warning" style="margin-left:4px">${me.incomingRequestsCount}</span>`
    : "";
  const inviteBadge = me?.incomingInvitesCount
    ? `<span class="tab-badge" style="margin-left:4px;background:#6366f1;color:#fff">${me.incomingInvitesCount}</span>`
    : "";
  return `<header class="topbar"><a class="brand" href="#home"><span class="brandmark">♫</span>sync<em>&</em>share</a><nav class="nav"><a href="#corner" class="${on === "corner" ? "active" : ""}">Your Corner</a><a href="#people" class="${on === "people" ? "active" : ""}">Find Friends${reqBadge}</a><a href="#discover" class="${on === "discover" ? "active" : ""}">Rooms${inviteBadge}</a><a href="#profile" class="profile-chip">${esc(me.name)}</a><button id="logout">Log out</button></nav></header>`;
}
function frame(content, on) {
  app.innerHTML = `<div class="shell">${nav(on)}<main class="main">${content}</main></div>`;
  document.querySelector("#logout")?.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    me = null;
    location.hash = "#login";
    render();
  });
}
async function authView(signup = false) {
  app.innerHTML = `<div class="shell"><header class="topbar"><a class="brand" href="#"><span class="brandmark">♫</span>sync<em>&</em>share</a></header><main class="auth-wrap"><section class="card auth-card"><span class="eyebrow">SOCIAL LISTENING</span><h1>${signup ? "Create your account" : "Sign in"}</h1><p class="muted" style="font-size:13px">${signup ? "Set up your profile and start listening together." : "Continue to your rooms and shared playlists."}</p><form id="authform">${signup ? `<label class="label">Display name</label><input class="input" name="name" maxlength="50" required placeholder="Your name">` : ""}<label class="label">Username</label><input class="input" name="username" minlength="3" maxlength="20" required autocomplete="username" placeholder="your_handle"><label class="label">Password</label><input class="input" type="password" name="password" minlength="8" required autocomplete="${signup ? "new-password" : "current-password"}" placeholder="At least 8 characters"><button class="button" style="width:100%;margin-top:18px">${signup ? "Create account" : "Sign in"}</button></form><div class="auth-switch">${signup ? "Already registered?" : "New to Sync & Share?"} <button class="text-btn" id="switch">${signup ? "Sign in" : "Create an account"}</button></div></section></main></div>`;
  document.querySelector("#switch").onclick = () => {
    location.hash = signup ? "login" : "signup";
    render();
  };
  document.querySelector("#authform").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const d = await api(`/auth/${signup ? "signup" : "login"}`, {
        method: "POST",
        body: JSON.stringify(f),
      });
      me = d.user;
      location.hash = "#home";
      render();
    } catch (err) {
      toast(err.message);
    }
  };
}
function personActionBtn(p) {
  if (p.isSelf) return '<span class="badge">YOU</span>';
  const status = p.friendshipStatus || (p.following ? "friends" : "none");
  if (status === "friends") {
    return `<button class="button secondary small" data-friend-action="remove" data-id="${esc(p.id)}">Friends ✓</button>`;
  }
  if (status === "outgoing_pending") {
    return `<button class="button secondary small" data-friend-action="cancel" data-id="${esc(p.id)}" data-request-id="${esc(p.requestId || "")}">Requested</button>`;
  }
  if (status === "incoming_pending") {
    return `<div class="btn-group"><button class="button small" data-friend-action="accept" data-id="${esc(p.id)}" data-request-id="${esc(p.requestId || "")}">Accept</button><button class="button secondary small" data-friend-action="decline" data-id="${esc(p.id)}" data-request-id="${esc(p.requestId || "")}">Decline</button></div>`;
  }
  return `<button class="button small" data-friend-action="request" data-id="${esc(p.id)}">+ Add Friend</button>`;
}
function personRow(p) {
  return `<div class="person-row">${avatar(p)}<div class="grow"><a href="#profile/${encodeURIComponent(p.username)}"><b>${esc(p.name)}</b></a><small>@${esc(p.username)}${p.activity ? ` · listening in ${esc(p.activity.room)}` : ""}</small></div>${personActionBtn(p)}</div>`;
}
function bindFriendActions(onDone) {
  document.querySelectorAll("[data-friend-action]").forEach((btn) => {
    btn.onclick = async () => {
      const action = btn.dataset.friendAction;
      const id = btn.dataset.id;
      const reqId = btn.dataset.requestId;
      btn.disabled = true;
      try {
        if (action === "request") {
          await api("/friends/request", {
            method: "POST",
            body: JSON.stringify({ targetId: id }),
          });
          toast("Friend request sent!");
        } else if (action === "accept") {
          await api("/friends/accept", {
            method: "POST",
            body: JSON.stringify({ requestId: reqId, userId: id }),
          });
          toast("Friend request accepted!");
        } else if (action === "decline") {
          await api("/friends/decline", {
            method: "POST",
            body: JSON.stringify({ requestId: reqId, userId: id }),
          });
          toast("Friend request declined");
        } else if (action === "cancel") {
          await api("/friends/cancel", {
            method: "POST",
            body: JSON.stringify({ requestId: reqId, targetId: id }),
          });
          toast("Request cancelled");
        } else if (action === "remove") {
          if (!confirm("Remove this friend?")) {
            btn.disabled = false;
            return;
          }
          await api("/friends/remove", {
            method: "POST",
            body: JSON.stringify({ targetId: id }),
          });
          toast("Friend removed");
        }
        if (onDone) await onDone();
        else render();
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
}
function bindRoomJoinActions(onDone) {
  document.querySelectorAll("[data-request-room-join]").forEach((btn) => {
    btn.onclick = async () => {
      const roomId = btn.dataset.requestRoomJoin;
      btn.disabled = true;
      try {
        await api(`/rooms/${roomId}/join-request`, { method: "POST" });
        toast("Join request sent to host!");
        if (onDone) await onDone();
        else render();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-cancel-room-join]").forEach((btn) => {
    btn.onclick = async () => {
      const roomId = btn.dataset.cancelRoomJoin;
      btn.disabled = true;
      try {
        await api(`/rooms/${roomId}/join-request`, { method: "DELETE" });
        toast("Join request cancelled");
        if (onDone) await onDone();
        else render();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });
}
async function openInviteModal(roomId, roomName, roomCode) {
  try {
    const d = await api(`/rooms/${roomId}/invite-candidates`);
    const candidates = d.candidates || [];
    const html = `
      <div style="min-width:300px;max-width:460px">
        <h2>Invite Friends</h2>
        <p class="muted" style="font-size:12px;margin-bottom:12px">Invite friends to listen together in <b>${esc(roomName)}</b>.</p>
        ${roomCode ? `<div class="card" style="padding:10px 14px;margin-bottom:14px;background:#151d28;border:1px solid #2a3b50"><small class="muted" style="display:block;margin-bottom:4px">Private Room Code:</small><div class="invite" style="font-size:16px;letter-spacing:1px">${esc(roomCode)}</div></div>` : ""}
        <div class="people-list" style="max-height:280px;overflow-y:auto;margin-bottom:14px">
          ${candidates.map((c) => `
            <div class="person-row" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
              ${avatar(c)}
              <div class="grow">
                <b>${esc(c.name)}</b>
                <small>@${esc(c.username)}</small>
              </div>
              <div>
                ${c.inRoom ? '<span class="badge">IN ROOM</span>' : c.invited ? '<button class="button secondary small" disabled style="opacity:0.6">Invited ✓</button>' : `<button class="button small" data-send-invite="${esc(c.id)}">Invite</button>`}
              </div>
            </div>
          `).join("") || '<div class="empty">No friends found. Add friends in Find Friends to invite them!</div>'}
        </div>
      </div>
    `;
    modal(html);
    document.querySelectorAll("[data-send-invite]").forEach((btn) => {
      btn.onclick = async () => {
        const targetUserId = btn.dataset.sendInvite;
        btn.disabled = true;
        btn.textContent = "Sending...";
        try {
          await api(`/rooms/${roomId}/invite`, {
            method: "POST",
            body: JSON.stringify({ targetUserId }),
          });
          toast("Invite sent!");
          btn.outerHTML = '<button class="button secondary small" disabled style="opacity:0.6">Invited ✓</button>';
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = "Invite";
        }
      };
    });
  } catch (err) {
    toast(err.message);
  }
}
async function home() {
  const [rooms, people] = await Promise.all([api("/rooms"), api("/people")]);
  frame(
    `<div class="hero"><div><span class="eyebrow">YOUR LISTENING SPACE</span><h1>Listen together.</h1><p>Join a room, share a playlist, and see what friends are playing.</p></div><button class="button" id="create">Create a room</button></div><div class="grid"><section class="card"><div class="card-head"><h2>Public rooms</h2><a class="eyebrow" href="#discover">VIEW ALL →</a></div><div class="room-list">${
      rooms.rooms
        .slice(0, 4)
        .map(
          (r) =>
            `<div class="room-row"><div class="room-icon">♫</div><div class="grow"><b>${esc(r.name)}</b><small>${r.members} ${r.members === 1 ? "listener" : "listeners"} · ${esc(r.track || "No track playing")}</small></div><button class="button small" data-join="${r.id}">Join</button></div>`,
        )
        .join("") ||
      `<div class="empty">No public rooms yet. Create one to get started.</div>`
    }</div></section><section class="card"><div class="card-head"><h2>Suggested friends</h2><a class="eyebrow" href="#people">FIND FRIENDS →</a></div><div class="people-list">${people.people.slice(0, 4).map(personRow).join("") || `<div class="empty">No new recommendations right now.</div>`}</div></section></div><div class="section card"><div class="card-head"><h2>Profile</h2><a class="eyebrow" href="#profile">EDIT PROFILE →</a></div><p class="muted" style="font-size:13px">${esc(me.bio || "Add a short bio to your profile.")}</p></div>`,
    "home",
  );
  bindCreate();
  bindJoin();
  bindFriendActions(home);
}
function bindJoin() {
  document.querySelectorAll("[data-join]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(`/rooms/${b.dataset.join}/join`, { method: "POST" });
          location.hash = `#room/${b.dataset.join}`;
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}
function bindCreate() {
  document.querySelector("#create")?.addEventListener("click", () =>
    modal(
      `<span class="eyebrow">Make a little room</span><h2 style="margin-top:8px">Start listening</h2><form id="createform"><label class="label">Room name</label><input class="input" name="name" maxlength="60" required placeholder="Late night rotation"><label class="checkrow"><input type="checkbox" name="isPrivate"> Private room · join by invite code</label><button class="button" style="width:100%;margin-top:19px">Create room</button></form>`,
      async (f) => {
        const d = await api("/rooms", {
          method: "POST",
          body: JSON.stringify({
            name: f.get("name"),
            isPrivate: f.has("isPrivate"),
          }),
        });
        if (d.inviteCode) sessionStorage.setItem("newInvite", d.inviteCode);
        location.hash = `#room/${d.room.id}`;
      },
    ),
  );
}
function modal(html, submit) {
  const root = document.createElement("div");
  root.className = "modal-back";
  root.innerHTML = `<section class="modal"><div class="modal-head"><span></span><button class="close" aria-label="Close">×</button></div>${html}</section>`;
  document.body.append(root);
  root.querySelector(".close").onclick = () => root.remove();
  root.onclick = (e) => {
    if (e.target === root) root.remove();
  };
  root.querySelector("form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await submit(new FormData(e.currentTarget));
      root.remove();
    } catch (err) {
      toast(err.message);
    }
  });
}
async function discover() {
  const [d, invitesData] = await Promise.all([
    api("/rooms"),
    api("/me/invites").catch(() => ({ invites: [] })),
  ]);
  const rooms = d.rooms || [],
    invites = invitesData.invites || [],
    active = rooms.filter((r) => r.status !== "closed").length;
  frame(
    `<div class="hero"><div><span class="eyebrow">DISCOVER</span><h1>Listening rooms</h1><p>Browse rooms you can join, manage, or reopen. Join private rooms with an invitation code.</p></div><button class="button" id="create">Create a room</button></div>${invites.length > 0 ? `<section class="card" style="margin-bottom:18px;background:#182030;border:1px solid #4f46e5;padding:16px"><div class="card-head"><h2>Room Invitations</h2><span class="badge" style="color:#a5b4fc;border-color:#6366f1">${invites.length} PENDING</span></div><p class="muted" style="font-size:12px;margin:-6px 0 14px">Your friends invited you to join their listening room.</p><div class="people-list">${invites.map((inv) => `<div class="person-row"><div class="grow"><b>${esc(inv.roomName)}</b><small>Invited by ${esc(inv.inviter?.name || "Friend")} (@${esc(inv.inviter?.username || "user")}) · ${new Date(inv.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div><div class="btn-group"><button class="button small" data-accept-invite="${esc(inv.id)}">Join Room</button><button class="button secondary small" data-decline-invite="${esc(inv.id)}">Decline</button></div></div>`).join("")}</div></section>` : ""}<section class="card"><div class="card-head"><h2>Rooms</h2><span class="eyebrow">${rooms.length} ROOMS · ${active} ACTIVE</span></div><div class="room-list">${rooms.map((r) => `<div class="room-row"><div class="room-icon">♫</div><div class="grow"><b>${esc(r.name)}</b><small>${r.isPrivate ? "Private · " : ""}${r.status === "closed" ? "Closed" : `${r.members} ${r.members === 1 ? "member" : "members"} · ${esc(r.track || "No track playing")}`}</small></div>${r.status === "closed" ? (r.isHost ? `<button class="button small" data-room-start="${esc(r.id)}">Start room</button>` : '<button class="button secondary small" disabled>Closed</button>') : r.isMember ? `<button class="button small" data-open-room="${esc(r.id)}">Open room</button>` : !r.isPrivate ? `<button class="button small" data-join="${esc(r.id)}">Join room</button>` : ""}</div>`).join("") || `<div class="empty">No rooms yet. Create one to get started.</div>`}</div></section><section class="card section"><h2>Join a private room</h2><p class="muted" style="font-size:12px">Enter the invitation code shared by the host.</p><form id="inviteform" class="formrow"><input class="input" name="code" required placeholder="Invitation code"><button class="button">Join room</button></form></section>`,
    "discover",
  );
  bindCreate();
  bindJoin();
  document.querySelectorAll("[data-accept-invite]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const res = await api(`/invites/${btn.dataset.acceptInvite}/accept`, { method: "POST" });
        toast("Joined room!");
        location.hash = `#room/${res.roomId}`;
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-decline-invite]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/invites/${btn.dataset.declineInvite}/decline`, { method: "POST" });
        toast("Invite declined");
        await discover();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    };
  });
  document
    .querySelectorAll("[data-open-room]")
    .forEach(
      (b) =>
        (b.onclick = () => (location.hash = `#room/${b.dataset.openRoom}`)),
    );
  document.querySelectorAll("[data-room-start]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/rooms/${b.dataset.roomStart}/status`, {
            method: "POST",
            body: JSON.stringify({ status: "active" }),
          });
          toast("Room started");
          await discover();
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      }),
  );
  document.querySelector("#inviteform").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api("/rooms/join", {
        method: "POST",
        body: JSON.stringify({
          code: new FormData(e.currentTarget).get("code"),
        }),
      });
      location.hash = `#room/${d.room.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
}
async function people() {
  await peoples();
}
async function profile(username) {
  const d = username
    ? await api(`/people/${encodeURIComponent(username)}`)
    : await api("/me");
  const u = d.user,
    own = !username,
    friends = d.friendsUsers || d.friends || d.followingUsers || [];
  let headerBtn = "";
  if (!own) {
    const st = d.friendshipStatus;
    if (st === "friends") {
      headerBtn = `<button class="button secondary" data-friend-action="remove" data-id="${esc(u.id)}">Friends ✓ (Unfriend)</button>`;
    } else if (st === "outgoing_pending") {
      headerBtn = `<button class="button secondary" data-friend-action="cancel" data-id="${esc(u.id)}" data-request-id="${esc(d.requestId || "")}">Request Sent · Cancel</button>`;
    } else if (st === "incoming_pending") {
      headerBtn = `<div class="btn-group"><button class="button" data-friend-action="accept" data-id="${esc(u.id)}" data-request-id="${esc(d.requestId || "")}">Accept Request</button><button class="button secondary" data-friend-action="decline" data-id="${esc(u.id)}" data-request-id="${esc(d.requestId || "")}">Decline</button></div>`;
    } else {
      headerBtn = `<button class="button" data-friend-action="request" data-id="${esc(u.id)}">+ Add Friend</button>`;
    }
  }
  const cornerRoomHtml = d.cornerRoom
    ? `<div class="card section" style="background:#1b2430;border:1px solid #3b82f6;padding:14px;margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><span class="badge" style="color:#60a5fa;border-color:#3b82f6">CORNER ROOM</span><span style="margin-left:8px">Listening to: <b>${esc(d.cornerRoom.trackTitle || "Music")}</b> in private corner room</span></div><div class="card-actions">${d.cornerRoom.isMember ? `<a class="button small" href="#room/${esc(d.cornerRoom.id)}">Enter Room</a>` : d.cornerRoom.hasRequestedJoin ? `<button class="button secondary small" data-cancel-room-join="${esc(d.cornerRoom.id)}">⏳ Join Requested</button>` : `<button class="button small" data-request-room-join="${esc(d.cornerRoom.id)}">Request to Join</button>`}</div></div></div>`
    : "";
  frame(
    `<div class="profile-head">${avatar(u)}<div class="grow"><span class="eyebrow">${own ? "YOUR PROFILE" : "LISTENER PROFILE"}</span><h1>${esc(u.name)}</h1><p>@${esc(u.username)}</p></div>${headerBtn}</div>${cornerRoomHtml}<div class="grid"><section class="card"><div class="card-head"><h2>About ${own ? "you" : esc(u.name)}</h2>${own ? '<button class="button secondary small" id="edit">Edit profile</button>' : ""}</div><p class="muted" style="font-size:13px">${esc(u.bio || "No bio yet.")}</p></section><section class="card"><div class="card-head"><h2>Listening now</h2><span class="badge">${d.cornerRoom ? "CORNER ROOM" : d.activity ? "SHARING" : "NOT SHARING"}</span></div>${d.cornerRoom ? `<p><b>${esc(d.cornerRoom.trackTitle || "Music")}</b><small class="subline">Private Room · Hosted by ${esc(u.name)}</small></p>${!own ? (d.cornerRoom.isMember ? `<a class="button small" href="#room/${esc(d.cornerRoom.id)}">Enter Room</a>` : d.cornerRoom.hasRequestedJoin ? `<button class="button secondary small" data-cancel-room-join="${esc(d.cornerRoom.id)}">⏳ Join Requested</button>` : `<button class="button small" data-request-room-join="${esc(d.cornerRoom.id)}">Request to Join</button>`) : `<a class="button small" href="#room/${esc(d.cornerRoom.id)}">Open Room View</a>`}` : d.activity ? `<p>${esc(d.activity.title || "YouTube video")}<small class="subline">${d.activity.playback === "playing" ? "Playing" : "Paused"} · ${esc(d.activity.audience || "shared audience")}</small></p>${!own ? `<button class="button small" id="profile-join">Join session</button>` : ""}` : `<p class="muted" style="font-size:12px">No session is currently shared with you.</p>`}</section></div><section class="card section"><div class="card-head"><h2>Friends</h2><span class="badge">${friends.length} FRIENDS</span></div><div class="people-list">${friends.map((p) => `<div class="person-row">${avatar(p)}<div class="grow"><a href="#profile/${encodeURIComponent(p.username)}"><b>${esc(p.name)}</b></a><small>@${esc(p.username)}</small></div></div>`).join("") || '<div class="empty">No friends added yet.</div>'}</div></section>${own ? `<section class="card section"><div class="card-head"><h2>Close Friends</h2><span class="badge">FRIENDS ONLY</span></div><p class="footer-note">Close Friends are selected from accounts you are friends with.</p><div id="profile-close-friends"></div></section><section class="card section"><h2>Activity privacy</h2><label class="label">Profile visibility</label><select class="select" id="visibility"><option value="everyone" ${u.visibility === "everyone" ? "selected" : ""}>Everyone</option><option value="followers" ${u.visibility === "followers" || u.visibility === "friends" ? "selected" : ""}>Friends only</option><option value="nobody" ${u.visibility === "nobody" ? "selected" : ""}>Nobody but you</option></select></section>` : ""}`,
    "profile",
  );
  if (own) {
    document.querySelector("#edit").onclick = () =>
      modal(
        `<h2>Edit your profile</h2><form><label class="label">Display name</label><input class="input" name="name" maxlength="50" value="${esc(u.name)}" required><label class="label">Bio</label><textarea class="textarea" name="bio" maxlength="180">${esc(u.bio || "")}</textarea><button class="button" style="width:100%;margin-top:14px">Save profile</button></form>`,
        async (f) => {
          await api("/profile", {
            method: "PATCH",
            body: JSON.stringify(Object.fromEntries(f)),
          });
          toast("Profile saved");
          render();
        },
      );
    document.querySelector("#visibility").onchange = async (e) => {
      try {
        await api("/profile", {
          method: "PATCH",
          body: JSON.stringify({ visibility: e.target.value }),
        });
        toast("Privacy preference saved");
      } catch (err) {
        toast(err.message);
      }
    };
    loadCloseFriends("#profile-close-friends");
  } else {
    bindFriendActions(() => profile(username));
    bindRoomJoinActions(() => profile(username));
    document
      .querySelector("#profile-join")
      ?.addEventListener("click", async () => {
        try {
          const x = await api(`/sessions/${d.activity.sessionId}/join`, {
            method: "POST",
          });
          sessionStorage.setItem("listeningSession", x.session.id);
          location.hash = `#session/${x.session.id}`;
        } catch (e) {
          toast(e.message);
        }
      });
  }
}
function youtubeInput(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return { type: "video", id: raw };
  if (/^(PL|UU|LL|RD|OL|FL|WL|TL|UL|PU)[A-Za-z0-9_-]{10,}$/i.test(raw))
    return { type: "playlist", id: raw };
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (
      ![
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
        "youtu.be",
      ].includes(host)
    )
      return null;
    const list = u.searchParams.get("list");
    if (list && /^[A-Za-z0-9_-]{10,100}$/.test(list))
      return { type: "playlist", id: list };
    let id = "";
    if (host === "youtu.be")
      id = u.pathname.split("/").filter(Boolean)[0] || "";
    else if (u.searchParams.get("v")) id = u.searchParams.get("v");
    else {
      const parts = u.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) id = parts[1] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { type: "video", id } : null;
  } catch {
    return null;
  }
}
function closedRoom(id, r) {
  syncGuard = true;
  try {
    ytPlayer?.pauseVideo?.();
    ytPlayer?.destroy?.();
  } catch {}
  ytPlayer = null;
  setTimeout(() => (syncGuard = false), 500);
  frame(
    `<div class="room-top"><div><span class="eyebrow">${r.isPrivate ? "PRIVATE ROOM" : "PUBLIC ROOM"}</span><h1>${esc(r.name)}</h1><span class="muted" style="font-size:11px">${r.members.length} ${r.members.length === 1 ? "member" : "members"} · ${r.host ? "Host" : "Member"} · Closed</span></div>${r.host ? '<button class="button" id="start-room">Start room</button>' : ""}<button class="button secondary small" id="leave">${r.host ? "Back to Rooms" : "Leave room"}</button></div><section class="card"><h2>Room is closed</h2><p class="muted" style="font-size:13px">The room and its queue are saved. The host must start it before members can listen, chat, vote, or add songs.</p><div class="track-list section">${r.queue.map((q, i) => `<div class="track"><span class="badge">${String(i + 1).padStart(2, "0")}</span><span class="track-title">${esc(q.title)}</span></div>`).join("") || '<div class="empty">The queue is empty.</div>'}</div></section>`,
    "discover",
  );
  document.querySelector("#start-room")?.addEventListener("click", async () => {
    try {
      await api(`/rooms/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "active" }),
      });
      toast("Room started");
      await room(id);
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelector("#leave").onclick = async () => {
    try {
      await api(`/rooms/${id}/leave`, { method: "POST" });
      location.hash = "#discover";
    } catch (e) {
      toast(e.message);
    }
  };
  clearInterval(poll);
  poll = setInterval(() => refreshRoom(id, true), 2000);
}
async function room(id) {
  const { room: r } = await api(`/rooms/${id}`);
  activeRoom = r;
  if (r.status === "closed") {
    closedRoom(id, r);
    return;
  }
  const q = r.nowPlaying;
  const currentIndex = r.queue.findIndex((x) => x.id === r.currentQueueId);
  const hasPrev = currentIndex > 0;
  const hasNext =
    currentIndex >= 0 ? currentIndex < r.queue.length - 1 : r.queue.length > 0;
  const invite = sessionStorage.getItem("newInvite");
  const embed = q
    ? q.type === "playlist"
      ? `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(q.playlistId)}&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`
      : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(q.videoId)}?enablejsapi=1&origin=${encodeURIComponent(location.origin)}`
    : "";
  frame(
    `<div class="room-top"><div><span class="eyebrow">${r.isPrivate ? "PRIVATE ROOM" : "PUBLIC ROOM"}</span><h1>${esc(r.name)}</h1><span class="muted" style="font-size:11px">${r.members.length} ${r.members.length === 1 ? "member" : "members"} · ${r.host ? "Host" : "Member"} · Active</span></div><div class="btn-group"><button class="button secondary small" id="open-invite-modal" title="Invite friends to this room">✉ Invite Friends</button>${r.host ? '<button class="button danger small" id="close-room">Close room</button>' : ""}<button class="button secondary small" id="leave">Leave room</button></div></div>${invite ? `<div class="card" style="margin-bottom:14px"><b>Invite people to this private room</b><div class="invite">${esc(invite)}</div><small class="subline">Share this code with people you want to join.</small></div>` : ""}${r.host && r.joinRequests && r.joinRequests.length > 0 ? `<div class="card" style="margin-bottom:14px;background:#1a2b25;border:1px solid #2ecc71;padding:14px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><span class="badge" style="color:#5cd68f;border-color:#2ecc71">JOIN REQUEST</span><span style="margin-left:8px"><b>${esc(r.joinRequests[0].userName)}</b> (@${esc(r.joinRequests[0].userHandle)}) requested to join this room.</span></div><div class="btn-group"><button class="button small" id="approve-join" data-req="${esc(r.joinRequests[0].id)}">✓ Allow Entry</button><button class="button secondary small" id="deny-join" data-req="${esc(r.joinRequests[0].id)}">✕ Deny</button></div></div></div>` : ""}${r.host && r.pauseRequests && r.pauseRequests.length > 0 ? `<div class="card" style="margin-bottom:14px;background:#2b1d16;border:1px solid #ff7f50;padding:14px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><span class="badge" style="color:#ff9e7d;border-color:#ff7f50">PAUSE REQUEST</span><span style="margin-left:8px"><b>${esc(r.pauseRequests[0].userName)}</b> requested to pause the video.</span></div><div class="btn-group"><button class="button small" id="approve-pause" data-req="${esc(r.pauseRequests[0].id)}">✓ Allow Pause</button><button class="button secondary small" id="deny-pause" data-req="${esc(r.pauseRequests[0].id)}">✕ Deny</button></div></div></div>` : ""}<div class="room-layout"><div><section class="card"><div class="card-head"><h2>${q ? `<span style="vertical-align:middle">${esc(q.title)}</span><a href="${trackYoutubeUrl(q)}" target="_blank" rel="noopener noreferrer" class="track-ext-link" title="Open video in YouTube" onclick="event.stopPropagation()">↗</a>` : "Now playing"}</h2><span class="badge">${r.playback === "playing" ? "PLAYING" : "PAUSED"}</span></div><div class="player">${q ? (q.type === "playlist" ? `<iframe title="YouTube playlist" src="${embed}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>` : `<div id="yt-player"></div>`) : `<div class="player-placeholder">♫<b>No selection</b>Add a YouTube video or playlist.</div>`}</div><div class="members">${r.members.map((m) => `<span class="member-pill">${esc(m.user.name)}${m.role === "host" ? " · host" : ""}</span>`).join("")}</div>${r.host ? `<div class="track-form" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><div class="btn-group"><button class="button secondary small" id="prev-track" title="Previous in queue"${!hasPrev ? " disabled style='opacity:0.4;cursor:not-allowed'" : ""}>⏮ Prev</button><button class="button small" id="playstate">${r.playback === "playing" ? "Pause" : "Play"}</button><button class="button secondary small" id="next-track" title="Next in queue"${!hasNext ? " disabled style='opacity:0.4;cursor:not-allowed'" : ""}>⏭ Next</button></div>${q ? `<span class="muted" style="font-size:11px;align-self:center">Host playback active${currentIndex >= 0 ? ` · Track ${currentIndex + 1} of ${r.queue.length}` : ""}</span>` : ""}</div>` : `<div class="track-form">${r.playback === "playing" ? (r.myPauseRequest ? `<span class="badge warning">⏳ Pause Requested</span><button class="button secondary small" id="cancel-pause">Cancel Request</button><span class="muted" style="font-size:11px;align-self:center">Waiting for host approval...</span>` : `<button class="button secondary small" id="request-pause">⏸ Request Pause</button><span class="muted" style="font-size:11px;align-self:center">Video is host-driven. Request pause from host.</span>`) : `<span class="badge">PAUSED</span><span class="muted" style="font-size:11px;align-self:center">Playback is paused. Host controls resume.</span>`}</div>`}<form id="trackform" class="track-form"><input class="input" name="url" required placeholder="Paste a YouTube video or playlist link"><input class="input" name="title" maxlength="100" placeholder="Title (optional)"><button class="button">Add to queue</button></form><p class="footer-note">Playlist links play through YouTube’s embedded player. Video availability and autoplay depend on YouTube and your browser.</p></section><section class="card section"><div class="card-head" style="align-items:flex-end"><div class="tab-bar" style="margin-bottom:0;padding-bottom:0;border-bottom:none"><button class="tab-btn ${currentRoomTab === 'queue' ? 'active' : ''}" data-room-tab="queue">Queue <span class="tab-badge">${r.queue.length}</span></button><button class="tab-btn ${currentRoomTab === 'history' ? 'active' : ''}" data-room-tab="history">Played History <span class="tab-badge">${(r.history || []).length}</span></button></div><div style="display:flex;align-items:center;gap:8px">${currentRoomTab === 'queue' && r.host && r.queue.length > 0 ? `<div class="btn-group"><button class="button secondary small" id="queue-prev" title="Previous in queue"${!hasPrev ? " disabled style='opacity:0.4;cursor:not-allowed'" : ""}>⏮ Prev</button><button class="button secondary small" id="queue-next" title="Next in queue"${!hasNext ? " disabled style='opacity:0.4;cursor:not-allowed'" : ""}>⏭ Next</button></div>` : ""}<span class="badge">${currentRoomTab === 'queue' ? `${r.queue.length} ${r.queue.length === 1 ? 'ITEM' : 'ITEMS'}` : `${(r.history || []).length} PLAYED`}</span></div></div>${currentRoomTab === 'queue' ? `<div class="track-list">${r.queue.map((x, i) => `<div class="track ${x.id === r.currentQueueId ? "active" : ""}" data-track-id="${x.id}" title="${r.host ? "Click to play this video" : "Click to view video on YouTube"}"><span class="badge">${String(i + 1).padStart(2, "0")}</span><span class="track-title">${x.type === "playlist" ? '<small class="queue-type">PLAYLIST · </small>' : ""}<a href="${trackYoutubeUrl(x)}" target="_blank" rel="noopener noreferrer" class="track-link" title="Open video in YouTube" onclick="event.stopPropagation()">${esc(x.title)}</a><a href="${trackYoutubeUrl(x)}" target="_blank" rel="noopener noreferrer" class="track-ext-link" title="Open video in YouTube" onclick="event.stopPropagation()">↗</a><small class="subline">Added by ${esc(x.by.name)}</small></span>${r.host ? `<button class="vote" data-play="${x.id}" title="Play this item">▶</button><button class="vote" data-remove="${x.id}" title="Remove">×</button>` : ""}<button class="vote" data-vote="${x.id}" data-value="${x.myVote === 1 ? 0 : 1}" title="Upvote">▲ ${x.votes}</button><button class="vote" data-vote="${x.id}" data-value="${x.myVote === -1 ? 0 : -1}" title="Downvote">▼</button></div>`).join("") || `<div class="empty">Add a video or playlist to start the queue.</div>`}</div>` : `<div class="track-list">${(r.history || []).map((x, i) => `<div class="track" data-track-id="${x.id}" title="${r.host ? "Click to play this video" : "Click to view video on YouTube"}"><span class="badge" style="opacity:0.8">#${(r.history || []).length - i}</span><span class="track-title">${x.type === "playlist" ? '<small class="queue-type">PLAYLIST · </small>' : ""}<a href="${trackYoutubeUrl(x)}" target="_blank" rel="noopener noreferrer" class="track-link" title="Open video in YouTube" onclick="event.stopPropagation()">${esc(x.title)}</a><a href="${trackYoutubeUrl(x)}" target="_blank" rel="noopener noreferrer" class="track-ext-link" title="Open video in YouTube" onclick="event.stopPropagation()">↗</a><small class="subline">Played · Originally added by ${esc(x.by?.name || "Member")}${x.playedAt ? ` · ${new Date(x.playedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</small></span><div class="btn-group" style="margin-left:auto;gap:6px"><button class="button secondary small" data-requeue="${esc(JSON.stringify({ type: x.type, videoId: x.videoId, playlistId: x.playlistId, title: x.title }))}" title="Add back to queue">+ Re-queue</button>${r.host ? `<button class="button small" data-play-history="${esc(JSON.stringify({ type: x.type, videoId: x.videoId, playlistId: x.playlistId, title: x.title }))}" title="Play now">▶ Play</button>` : ""}</div></div>`).join("") || `<div class="empty">No songs played yet. Tracks played in this room will appear here.</div>`}</div>`}</section></div><section class="card chat-card"><div class="card-head"><h2>Room chat</h2><span class="badge">ROOM MEMBERS</span></div><div id="messages" class="chat-messages">${r.messages.map(messageHtml).join("") || `<div class="empty">No messages yet.</div>`}</div><form id="chatform" class="chat-form"><input class="input" name="text" maxlength="500" required placeholder="Write a message…"><button class="button small">Send</button></form><p class="footer-note">Room updates refresh every few seconds. Chat is visible only to members.</p></section></div>`,
    "",
  );
  if (q?.type === "video") startPlayer(r);
  if (invite) sessionStorage.removeItem("newInvite");
  document.querySelector("#open-invite-modal")?.addEventListener("click", () => {
    openInviteModal(id, r.name, r.code);
  });
  document.querySelector("#close-room")?.addEventListener("click", async () => {
    try {
      await api(`/rooms/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "closed" }),
      });
      toast("Room closed");
      await room(id);
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelector("#leave").onclick = async () => {
    try {
      await api(`/rooms/${id}/leave`, { method: "POST" });
      clearInterval(poll);
      location.hash = "#home";
    } catch (e) {
      toast(e.message);
    }
  };
  document.querySelector("#approve-join")?.addEventListener("click", async (e) => {
    try {
      const reqId = e.currentTarget.dataset.req;
      await api(`/rooms/${id}/join-request/${reqId}/approve`, { method: "POST" });
      toast("Allowed entry to room!");
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#deny-join")?.addEventListener("click", async (e) => {
    try {
      const reqId = e.currentTarget.dataset.req;
      await api(`/rooms/${id}/join-request/${reqId}/deny`, { method: "POST" });
      toast("Join request denied.");
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#request-pause")?.addEventListener("click", async () => {
    try {
      await api(`/rooms/${id}/pause-request`, { method: "POST" });
      toast("Pause request sent to host!");
      await refreshRoom(id);
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelector("#cancel-pause")?.addEventListener("click", async () => {
    try {
      await api(`/rooms/${id}/pause-request`, { method: "DELETE" });
      toast("Pause request cancelled");
      await refreshRoom(id);
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelector("#approve-pause")?.addEventListener("click", async (e) => {
    try {
      const reqId = e.currentTarget.dataset.req;
      if (ytPlayer?.pauseVideo) {
        syncGuard = true;
        ytPlayer.pauseVideo();
        setTimeout(() => (syncGuard = false), 500);
      }
      await api(`/rooms/${id}/pause-request/${reqId}/approve`, {
        method: "POST",
        body: JSON.stringify({ position: ytPlayer?.getCurrentTime?.() || 0 }),
      });
      toast("Allowed pause. Playback paused for room.");
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#deny-pause")?.addEventListener("click", async (e) => {
    try {
      const reqId = e.currentTarget.dataset.req;
      await api(`/rooms/${id}/pause-request/${reqId}/deny`, { method: "POST" });
      toast("Pause request denied. Video continues.");
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#trackform").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      parsed = youtubeInput(f.get("url"));
    if (!parsed) {
      toast("Paste a valid YouTube video link, video ID, or playlist link.");
      return;
    }
    try {
      await api(`/rooms/${id}/queue`, {
        method: "POST",
        body: JSON.stringify({
          type: parsed.type,
          [parsed.type === "playlist" ? "playlistId" : "videoId"]: parsed.id,
          title: f.get("title"),
        }),
      });
      toast(
        parsed.type === "playlist"
          ? "Playlist added to queue"
          : "Video added to queue",
      );
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  };
  document.querySelector("#playstate")?.addEventListener("click", async () => {
    try {
      const status = r.playback === "playing" ? "paused" : "playing";
      if (ytPlayer?.getPlayerState) {
        syncGuard = true;
        status === "playing" ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
        setTimeout(() => (syncGuard = false), 500);
      }
      await postPlayback(id, {
        status,
        position: ytPlayer?.getCurrentTime?.() || r.playbackPosition || 0,
      });
      await refreshRoom(id);
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelectorAll("[data-play]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(`/rooms/${id}/play`, {
            method: "POST",
            body: JSON.stringify({
              queueId: b.dataset.play,
              status: "playing",
            }),
          });
          await refreshRoom(id);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(`/rooms/${id}/queue/${b.dataset.remove}`, {
            method: "DELETE",
          });
          await refreshRoom(id);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-vote]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(`/rooms/${id}/queue/${b.dataset.vote}/vote`, {
            method: "POST",
            body: JSON.stringify({ value: Number(b.dataset.value) }),
          });
          await refreshRoom(id);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-room-tab]").forEach((btn) => {
    btn.onclick = () => {
      currentRoomTab = btn.dataset.roomTab;
      const y = window.scrollY;
      room(id).then(() => window.scrollTo(0, y));
    };
  });
  document.querySelectorAll("[data-requeue]").forEach((b) => {
    b.onclick = async () => {
      try {
        const item = JSON.parse(b.dataset.requeue);
        await api(`/rooms/${id}/queue`, {
          method: "POST",
          body: JSON.stringify(item),
        });
        toast("Re-added to queue!");
        currentRoomTab = "queue";
        await refreshRoom(id);
      } catch (err) {
        toast(err.message);
      }
    };
  });
  document.querySelectorAll("[data-play-history]").forEach((b) => {
    b.onclick = async () => {
      try {
        const item = JSON.parse(b.dataset.playHistory);
        const res = await api(`/rooms/${id}/queue`, {
          method: "POST",
          body: JSON.stringify(item),
        });
        const addedItem = res?.room?.queue?.[res?.room?.queue?.length - 1];
        if (addedItem?.id) {
          await api(`/rooms/${id}/play`, {
            method: "POST",
            body: JSON.stringify({
              queueId: addedItem.id,
              status: "playing",
            }),
          });
        }
        toast("Playing track!");
        currentRoomTab = "queue";
        await refreshRoom(id);
      } catch (err) {
        toast(err.message);
      }
    };
  });
  const handleNext = async () => {
    try {
      await api(`/rooms/${id}/next`, { method: "POST" });
      toast("Playing next track");
      await refreshRoom(id);
    } catch (e) {
      toast(e.message);
    }
  };
  const handlePrev = async () => {
    try {
      await api(`/rooms/${id}/previous`, { method: "POST" });
      toast("Playing previous track");
      await refreshRoom(id);
    } catch (e) {
      toast(e.message);
    }
  };
  document.querySelectorAll("#prev-track, #queue-prev").forEach((btn) => {
    btn.onclick = handlePrev;
  });
  document.querySelectorAll("#next-track, #queue-next").forEach((btn) => {
    btn.onclick = handleNext;
  });
  document.querySelectorAll(".track[data-track-id]").forEach((trackEl) => {
    trackEl.addEventListener("click", async (e) => {
      if (e.target.closest("button") || e.target.closest("a")) return;
      const tId = trackEl.dataset.trackId;
      if (r.host && tId) {
        if (tId !== r.currentQueueId) {
          try {
            await api(`/rooms/${id}/play`, {
              method: "POST",
              body: JSON.stringify({ queueId: tId, status: "playing" }),
            });
            toast("Playing selected track");
            await refreshRoom(id);
          } catch (err) {
            toast(err.message);
          }
        }
      } else if (tId) {
        const item =
          r.queue.find((t) => t.id === tId) ||
          (r.history || []).find((t) => t.id === tId);
        const url = trackYoutubeUrl(item);
        if (url) window.open(url, "_blank");
      }
    });
  });
  document.querySelector("#chatform").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/rooms/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: f.get("text") }),
      });
      e.currentTarget.reset();
      await refreshRoom(id);
    } catch (err) {
      toast(err.message);
    }
  };
  clearInterval(poll);
  poll = setInterval(() => refreshRoom(id, true), 2000);
}
function messageHtml(m) {
  return `<div class="message"><b>${esc(m.user.name)}</b><time>${new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div>${formatChatMessage(m.text)}</div></div>`;
}
async function refreshRoom(id, silent = false) {
  try {
    const d = await api(`/rooms/${id}`),
      next = d.room,
      old = activeRoom;
    if (
      !old ||
      old.status !== next.status ||
      old.currentQueueId !== next.currentQueueId ||
      old.queue.length !== next.queue.length ||
      old.messages.length !== next.messages.length ||
      (old.history || []).length !== (next.history || []).length ||
      (old.pauseRequests || []).length !== (next.pauseRequests || []).length ||
      (old.joinRequests || []).length !== (next.joinRequests || []).length ||
      (old.members || []).length !== (next.members || []).length
    ) {
      const y = window.scrollY;
      room(id).then(() => window.scrollTo(0, y));
      return;
    }
    activeRoom = next;
    document
      .querySelector(".card-head .badge")
      ?.replaceChildren(
        document.createTextNode(
          next.playback === "playing" ? "PLAYING" : "PAUSED",
        ),
      );
    const playButton = document.querySelector("#playstate");
    if (playButton)
      playButton.textContent = next.playback === "playing" ? "Pause" : "Play";
    syncPlayer(next);
    if (
      next.host &&
      next.playback === "playing" &&
      ytPlayer?.getCurrentTime &&
      Date.now() - lastSyncPost > 5000
    )
      postPlayback(id, { position: ytPlayer.getCurrentTime() || 0 });
  } catch (e) {
    if (!silent) toast(e.message);
  }
}
let viewMode = "room",
  viewSession = null,
  viewIsHost = false,
  viewSyncing = false,
  cornerTimer = null;
function startSocialPlayer(videoId, state, isHost) {
  viewMode = isHost ? "corner" : "session";
  loadYouTubeApi().then(() => {
    if (!document.querySelector("#yt-player")) return;
    ytPlayer?.destroy?.();
    ytPlayer = new YT.Player("yt-player", {
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,
        controls: isHost ? 1 : 0,
        origin: location.origin,
      },
      events: {
        onReady: () => applySocialState(state, true),
        onStateChange: (e) => {
          if (
            e.data === YT.PlayerState.PLAYING ||
            e.data === YT.PlayerState.PAUSED
          ) {
            const status =
              e.data === YT.PlayerState.PLAYING ? "playing" : "paused";
            if (isHost && !viewSyncing)
              sendSocialState({
                status,
                position: ytPlayer.getCurrentTime() || 0,
              });
            const button = document.querySelector("#cornerplay");
            if (button && isHost)
              button.textContent = status === "playing" ? "Pause" : "Play";
            const badge = document.querySelector(".card-head .badge");
            if (badge && isHost) badge.textContent = status.toUpperCase();
          }
        },
        onError: (e) => {
          const n = document.querySelector("#player-error");
          if (n)
            n.textContent = `YouTube could not play this video (error ${e.data}). It may be unavailable or embedding may be restricted.`;
        },
      },
    });
  });
}
function applySocialState(s, force = false) {
  if (!ytPlayer?.getCurrentTime || !s) return;
  const isSession = viewMode === "session",
    canFollow = !isSession || s.hostActive;
  if (!canFollow) return;
  const elapsed =
      s.playback === "playing"
        ? Math.max(0, (Date.now() - s.updatedAt) / 1000)
        : 0,
    target = (Number(s.position) || 0) + elapsed,
    current = ytPlayer.getCurrentTime() || 0;
  if (force || Math.abs(current - target) > 3) {
    viewSyncing = true;
    try {
      if (force || Math.abs(current - target) > 5)
        ytPlayer.seekTo(target, true);
      if (s.playback === "playing") ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } catch {}
    setTimeout(() => (viewSyncing = false), 700);
  }
}
async function sendSocialState(data) {
  const endpoint =
    viewMode === "corner" ? "/corner/play" : `/sessions/${viewSession.id}/play`;
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify(data) });
  } catch (e) {
    toast(e.message);
  }
}
async function corner() {
  clearInterval(poll);
  const oldSession = sessionStorage.getItem("listeningSession");
  if (oldSession) {
    api(`/sessions/${oldSession}/leave`, { method: "POST" }).catch(() => {});
    sessionStorage.removeItem("listeningSession");
  }
  const d = await api("/corner"),
    c = d.corner || {};
  frame(
    `<div class="hero"><div><span class="eyebrow">YOUR PERSONAL LISTENING SPACE</span><h1>Your Corner</h1><p>Listen on your own. Share when you want friends to join.</p></div></div>${d.cornerJoinRequests && d.cornerJoinRequests.length > 0 ? `<div class="card" style="margin-bottom:14px;background:#1a2b25;border:1px solid #2ecc71;padding:14px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><span class="badge" style="color:#5cd68f;border-color:#2ecc71">CORNER JOIN REQUEST</span><span style="margin-left:8px"><b>${esc(d.cornerJoinRequests[0].userName)}</b> (@${esc(d.cornerJoinRequests[0].userHandle)}) requested to join your corner room.</span></div><div class="btn-group"><button class="button small" id="approve-corner-join" data-room="${esc(d.cornerRoom?.id)}" data-req="${esc(d.cornerJoinRequests[0].id)}">✓ Allow Entry</button><button class="button secondary small" id="deny-corner-join" data-room="${esc(d.cornerRoom?.id)}" data-req="${esc(d.cornerJoinRequests[0].id)}">✕ Deny</button></div></div></div>` : ""}${d.cornerRoom ? `<div class="card" style="margin-bottom:14px;background:#161d27;border:1px solid #2b394a;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><span class="badge" style="color:#60a5fa;border-color:#3b82f6">CORNER ROOM ACTIVE</span><span style="margin-left:8px;font-size:13px"><b>${esc(d.cornerRoom.name)}</b> · Private Code: <code style="color:#93c5fd;font-weight:600">${esc(d.cornerRoom.code)}</code> · ${d.cornerRoom.members.length} ${d.cornerRoom.members.length === 1 ? 'member' : 'members'}</span></div><div class="btn-group"><a class="button small" href="#room/${esc(d.cornerRoom.id)}">Open Room View</a><button class="button secondary small" id="corner-invite-btn">✉ Invite Friends</button></div></div>` : ""}<div class="grid"><section class="card"><div class="card-head"><h2>${esc(c.title || "Now playing")}</h2><span class="badge">${c.playback === "playing" ? "PLAYING" : "PAUSED"}</span></div><div class="player">${c.videoId ? '<div id="yt-player"></div>' : '<div class="player-placeholder">♫<b>No selection</b>Paste a YouTube video link to begin.</div>'}</div><div id="player-error" class="footer-note" role="status"></div><form id="cornerform" class="track-form"><input class="input" name="url" placeholder="YouTube video URL or ID" required><input class="input" name="title" maxlength="100" placeholder="Song title (optional)"><button class="button" name="action" value="load">Load video</button><button class="button secondary" name="action" value="queue">Add to queue</button></form><div class="track-form"><button id="cornerplay" class="button small">${c.playback === "playing" ? "Pause" : "Play"}</button><label class="muted" style="font-size:12px;align-self:center">Seek</label><input id="seek" class="input" type="range" min="0" max="100" value="0"><span id="progress" class="muted" style="font-size:11px;align-self:center">0:00</span></div><div class="track-list section">${(c.queue || []).map((x, i) => `<div class="track ${x.videoId === c.videoId ? "active" : ""}"><span class="badge">${String(i + 1).padStart(2, "0")}</span><span class="track-title">${esc(x.title)}</span>${x.videoId === c.videoId ? '<small class="muted">Now playing</small>' : '<button class="vote" data-corner-play="' + esc(x.id) + '" title="Play this track">▶</button>'}</div>`).join("") || '<div class="empty">Your queue is empty.</div>'}</div><button class="button secondary small" id="corner-next">Skip to next</button><p class="footer-note">YouTube playback stays in this browser. Autoplay may require clicking Play.</p></section><section class="card"><div class="card-head"><h2>Share Listening</h2><span class="badge">${esc(d.session && d.session.audience !== "off" ? "SHARING" : "OFF")}</span></div><p class="muted" style="font-size:12px">Choose who can discover and join your current video.</p><label class="label" for="audience">Audience</label><select class="select" id="audience"><option value="off">Off</option><option value="everyone">Everyone</option><option value="followers">Followers</option><option value="close-friends">Close Friends</option></select><p id="share-status" class="footer-note">${d.session ? `Session active · audience: ${esc(d.session.audience)}.` : "Your session is private."}</p>${d.session?.status === "active" ? `<a class="button secondary small" href="#session/${esc(d.session.id)}">Open session · ${d.session.participants?.length || 0} listeners</a>` : ""}<div id="close-friends"></div>${d.session?.status === "active" ? `<button class="button secondary small" id="endsession">End shared session</button>` : ""}</section></div>`,
    "corner",
  );
  document.querySelector("#approve-corner-join")?.addEventListener("click", async (e) => {
    try {
      const roomId = e.currentTarget.dataset.room;
      const reqId = e.currentTarget.dataset.req;
      await api(`/rooms/${roomId}/join-request/${reqId}/approve`, { method: "POST" });
      toast("Allowed entry to corner room!");
      await corner();
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#deny-corner-join")?.addEventListener("click", async (e) => {
    try {
      const roomId = e.currentTarget.dataset.room;
      const reqId = e.currentTarget.dataset.req;
      await api(`/rooms/${roomId}/join-request/${reqId}/deny`, { method: "POST" });
      toast("Join request denied.");
      await corner();
    } catch (err) {
      toast(err.message);
    }
  });
  document.querySelector("#corner-invite-btn")?.addEventListener("click", () => {
    if (d.cornerRoom) {
      openInviteModal(d.cornerRoom.id, d.cornerRoom.name, d.cornerRoom.code);
    }
  });
  const audience = document.querySelector("#audience");
  audience.value = d.session?.audience || "off";
  if (c.videoId) startSocialPlayer(c.videoId, c, true);
  document.querySelector("#cornerform").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      p = youtubeInput(f.get("url"));
    if (!p || p.type !== "video") {
      toast(
        "Use a YouTube video URL or 11-character video ID. Playlist-only and unsupported YouTube Music links cannot load as one video.",
      );
      return;
    }
    try {
      if (e.submitter?.value === "queue") {
        await api("/corner/queue", {
          method: "POST",
          body: JSON.stringify({ videoId: p.id, title: f.get("title") }),
        });
        toast("Added to your queue");
      } else
        await api("/corner", {
          method: "PUT",
          body: JSON.stringify({ videoId: p.id, title: f.get("title") }),
        });
      await corner();
    } catch (err) {
      toast(err.message);
    }
  };
  document.querySelector("#corner-next").onclick = async () => {
    try {
      await api("/corner/next", { method: "POST" });
      await corner();
    } catch (e) {
      toast(e.message);
    }
  };
  document.querySelectorAll("[data-corner-play]").forEach(
    (b) =>
      (b.onclick = async () => {
        const x = (c.queue || []).find((q) => q.id === b.dataset.cornerPlay);
        if (!x) return;
        try {
          await api("/corner", {
            method: "PUT",
            body: JSON.stringify({ videoId: x.videoId, title: x.title }),
          });
          await corner();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  audience.onchange = async () => {
    try {
      await api("/share", {
        method: "POST",
        body: JSON.stringify({ audience: audience.value }),
      });
      toast(
        audience.value === "off"
          ? "Sharing turned off"
          : "Listening session updated",
      );
      await corner();
    } catch (e) {
      toast(e.message);
      audience.value = d.session?.audience || "off";
    }
  };
  document.querySelector("#cornerplay").onclick = async () => {
    const state = c.playback === "playing" ? "paused" : "playing";
    try {
      if (ytPlayer)
        state === "playing" ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
      await sendSocialState({
        status: state,
        position: ytPlayer?.getCurrentTime?.() || c.position || 0,
      });
      c.playback = state;
      document.querySelector("#cornerplay").textContent =
        state === "playing" ? "Pause" : "Play";
    } catch (e) {
      toast(e.message);
    }
  };
  document.querySelector("#seek").onchange = async (e) => {
    const position = Number(e.target.value);
    ytPlayer?.seekTo(position, true);
    await sendSocialState({ position });
  };
  document.querySelector("#endsession")?.addEventListener("click", async () => {
    await api("/corner/end", { method: "POST" });
    await corner();
  });
  if (audience.value === "close-friends") loadCloseFriends();
  let lastCornerPoll = Date.now();
  clearInterval(cornerTimer);
  cornerTimer = setInterval(() => {
    if (viewMode !== "corner") return;
    if (ytPlayer?.getCurrentTime) {
      const p = ytPlayer.getCurrentTime() || 0,
        seek = document.querySelector("#seek"),
        out = document.querySelector("#progress"),
        pb = document.querySelector("#cornerplay"),
        playing = ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING;
      if (pb) pb.textContent = playing ? "Pause" : "Play";
      c.playback = playing ? "playing" : "paused";
      if (seek) {
        seek.max = String(Math.max(100, p, ytPlayer.getDuration?.() || 0));
        seek.value = String(p);
      }
      if (out)
        out.textContent = `${Math.floor(p / 60)}:${String(Math.floor(p % 60)).padStart(2, "0")}`;
      if (playing && Date.now() - lastSyncPost > 5000) {
        lastSyncPost = Date.now();
        sendSocialState({ position: p });
      }
    }
    const a = document.querySelector("#audience")?.value;
    if (a && a !== "off" && Date.now() - lastSyncPost > 8000)
      api("/share", {
        method: "POST",
        body: JSON.stringify({ audience: a }),
      }).catch(() => {});
    if (Date.now() - lastCornerPoll > 4000) {
      lastCornerPoll = Date.now();
      api("/corner").then((fresh) => {
        const freshReqs = (fresh.cornerJoinRequests || []).length;
        const oldReqs = (d.cornerJoinRequests || []).length;
        const freshMembers = fresh.cornerRoom?.members?.length || 0;
        const oldMembers = d.cornerRoom?.members?.length || 0;
        if (freshReqs !== oldReqs || freshMembers !== oldMembers) {
          corner();
        }
      }).catch(() => {});
    }
  }, 2000);
}
async function loadCloseFriends(target = "#close-friends") {
  const box = document.querySelector(target);
  if (!box) return;
  try {
    const d = await api("/close-friends");
    box.innerHTML = `<div class="people-list">${d.people.map((p) => `<label class="checkrow"><input type="checkbox" data-close="${esc(p.id)}" ${p.selected ? "checked" : ""}>${esc(p.name)} (@${esc(p.username)})${p.selected ? "<small> · Close Friend</small>" : ""}</label>`).join("") || '<p class="footer-note">Follow someone first to add them here.</p>'}</div><button class="button secondary small" id="save-close">Save Close Friends</button>`;
    document.querySelector("#save-close").onclick = async () => {
      const userIds = [...box.querySelectorAll("[data-close]:checked")].map(
        (x) => x.dataset.close,
      );
      try {
        await api("/close-friends", {
          method: "PUT",
          body: JSON.stringify({ userIds }),
        });
        toast("Close Friends saved");
        await loadCloseFriends(target);
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    box.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`;
  }
}
let peopleTab = "suggested";
let peopleSearchQuery = "";

function accountCard(p) {
  let status = "";
  if (p.cornerRoom) {
    status = `🎧 Listening: ${esc(p.cornerRoom.trackTitle || "Music")} · Private Room`;
  } else if (p.activity) {
    status = `${esc(p.activity.title || "YouTube video")} · ${p.activity.playback === "playing" ? "Playing" : "Paused"} · ${p.activity.audience}`;
  } else if (p.isSelf) {
    status = "This is your account";
  } else if (p.sharing) {
    status = "Sharing with another audience";
  } else {
    status = "Not sharing";
  }
  const action = p.isSelf ? '<span class="badge">YOU</span>' : personActionBtn(p);
  const sessionBtn = p.activity?.sessionId
    ? `<button class="button small" data-session="${esc(p.activity.sessionId)}">Join</button>`
    : "";
  let cornerBtn = "";
  if (!p.isSelf && p.cornerRoom) {
    if (p.cornerRoom.isMember) {
      cornerBtn = `<a class="button small" href="#room/${esc(p.cornerRoom.id)}">Enter Room</a>`;
    } else if (p.cornerRoom.hasRequestedJoin) {
      cornerBtn = `<button class="button secondary small" data-cancel-room-join="${esc(p.cornerRoom.id)}">⏳ Requested</button>`;
    } else {
      cornerBtn = `<button class="button small" data-request-room-join="${esc(p.cornerRoom.id)}">Request to Join</button>`;
    }
  }
  return `<div class="person-row">${avatar(p)}<div class="grow"><a href="#profile/${encodeURIComponent(p.username)}"><b>${esc(p.name)}</b></a><small>@${esc(p.username)} · ${status}</small></div><div class="card-actions">${action}${sessionBtn}${cornerBtn}</div></div>`;
}

function requestCard(r, isIncoming) {
  const u = r.user;
  const actions = isIncoming
    ? `<div class="btn-group"><button class="button small" data-friend-action="accept" data-request-id="${esc(r.requestId)}" data-id="${esc(u.id)}">Accept</button><button class="button secondary small" data-friend-action="decline" data-request-id="${esc(r.requestId)}" data-id="${esc(u.id)}">Decline</button></div>`
    : `<button class="button secondary small" data-friend-action="cancel" data-request-id="${esc(r.requestId)}" data-id="${esc(u.id)}">Cancel Request</button>`;
  return `<div class="person-row">${avatar(u)}<div class="grow"><a href="#profile/${encodeURIComponent(u.username)}"><b>${esc(u.name)}</b></a><small>@${esc(u.username)} · ${isIncoming ? "Wants to be friends" : "Request pending"}</small></div>${actions}</div>`;
}

async function peoples() {
  frame(
    '<div class="empty">Loading accounts and recommendations…</div>',
    "people",
  );
  let d;
  try {
    const url = peopleSearchQuery
      ? `/peoples?q=${encodeURIComponent(peopleSearchQuery)}`
      : "/peoples";
    d = await api(url);
  } catch (e) {
    frame(
      `<div class="empty">Could not load Peoples: ${esc(e.message)} <button class="button small" id="retry-peoples">Retry</button></div>`,
      "people",
    );
    document.querySelector("#retry-peoples").onclick = peoples;
    return;
  }

  const recommendations = d.recommendations || [];
  const searchResults = d.searchResults || null;
  const friends = d.friends || [];
  const incoming = d.incomingRequests || [];
  const outgoing = d.outgoingRequests || [];
  const hasIncoming = incoming.length > 0;

  let bodyContent = "";
  if (searchResults !== null) {
    bodyContent = `<div class="card-head"><h2>Search Results for "${esc(peopleSearchQuery)}"</h2><span class="badge">${searchResults.length} FOUND</span></div>
      <div class="people-list">${searchResults.map(accountCard).join("") || '<div class="empty">No listeners matched your search. Try another username or name.</div>'}</div>`;
  } else if (peopleTab === "requests") {
    bodyContent = `
      <div class="requests-subhead">Incoming Requests (${incoming.length})</div>
      <div class="people-list">${incoming.map((r) => requestCard(r, true)).join("") || '<div class="empty">No pending friend requests.</div>'}</div>
      <div class="requests-subhead" style="margin-top:24px">Sent Requests (${outgoing.length})</div>
      <div class="people-list">${outgoing.map((r) => requestCard(r, false)).join("") || '<div class="empty">No pending sent requests.</div>'}</div>
    `;
  } else if (peopleTab === "friends") {
    bodyContent = `<div class="card-head"><h2>Your Friends</h2><span class="badge">${friends.length} FRIENDS</span></div>
      <div class="people-list">${friends.map(accountCard).join("") || '<div class="empty">You have no friends added yet. Send friend requests from the Suggested tab or search above!</div>'}</div>`;
  } else {
    bodyContent = `<div class="card-head"><h2>Suggested Listeners</h2><span class="badge">${recommendations.length} SUGGESTIONS</span></div>
      <p class="muted" style="font-size:12px;margin:-6px 0 14px">Recommendations for you (max 10-20). Other listeners are private unless searched directly.</p>
      <div class="people-list">${recommendations.map(accountCard).join("") || '<div class="empty">No new suggestions right now. Search above to find friends by handle!</div>'}</div>`;
  }

  frame(
    `<div class="hero"><div><span class="eyebrow">SOCIAL LISTENING</span><h1>Find Friends</h1><p>Connect with other listeners, manage friend requests, and listen together.</p></div></div>
    <div class="search-bar-wrap">
      <form id="people-search-form" class="search-bar">
        <input id="people-search-input" class="input" placeholder="Search listeners by username or display name..." value="${esc(peopleSearchQuery)}" autocomplete="off">
        <button type="submit" class="button small">Search</button>
        ${peopleSearchQuery ? '<button type="button" id="people-search-clear" class="button secondary small">Clear</button>' : ""}
      </form>
    </div>
    <div class="tab-bar">
      <button class="tab-btn ${!searchResults && peopleTab === "suggested" ? "active" : ""}" data-tab="suggested">Suggested <span class="tab-badge">${recommendations.length}</span></button>
      <button class="tab-btn ${!searchResults && peopleTab === "requests" ? "active" : ""}" data-tab="requests">Friend Requests <span class="tab-badge ${hasIncoming ? "warning" : ""}">${incoming.length}</span></button>
      <button class="tab-btn ${!searchResults && peopleTab === "friends" ? "active" : ""}" data-tab="friends">Friends <span class="tab-badge">${friends.length}</span></button>
    </div>
    <section class="card">${bodyContent}</section>`,
    "people",
  );

  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      peopleSearchQuery = "";
      peopleTab = btn.dataset.tab;
      peoples();
    };
  });

  const searchForm = document.querySelector("#people-search-form");
  searchForm.onsubmit = (e) => {
    e.preventDefault();
    const val = document.querySelector("#people-search-input").value.trim();
    peopleSearchQuery = val;
    peoples();
  };

  const clearBtn = document.querySelector("#people-search-clear");
  if (clearBtn) {
    clearBtn.onclick = () => {
      peopleSearchQuery = "";
      peoples();
    };
  }

  bindFriendActions(peoples);
  bindRoomJoinActions(peoples);
  bindPeopleSessionActions();

  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const url = peopleSearchQuery
        ? `/peoples?q=${encodeURIComponent(peopleSearchQuery)}`
        : "/peoples";
      const fresh = await api(url);
      const badgeReq = document.querySelector(
        '.tab-btn[data-tab="requests"] .tab-badge',
      );
      if (badgeReq) badgeReq.textContent = fresh.incomingRequests?.length || 0;
      const badgeFriends = document.querySelector(
        '.tab-btn[data-tab="friends"] .tab-badge',
      );
      if (badgeFriends) badgeFriends.textContent = fresh.friends?.length || 0;
    } catch {}
  }, 8000);
}

function bindPeopleSessionActions() {
  document.querySelectorAll("[data-session]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          const d = await api(`/sessions/${b.dataset.session}/join`, {
            method: "POST",
          });
          sessionStorage.setItem("listeningSession", d.session.id);
          location.hash = `#session/${d.session.id}`;
        } catch (e) {
          toast(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
async function loadSessionRequests(id, isHost) {
  const result = await api(`/sessions/${id}/requests`),
    requests = result.requests || [];
  if (isHost) {
    const box = document.querySelector("#host-requests"),
      count = document.querySelector("#request-count");
    const pending = requests.filter((r) => r.status === "pending").length;
    if (count)
      count.textContent = `${pending} pending · ${requests.length} total`;
    if (box)
      box.innerHTML =
        requests
          .map(
            (r) =>
              `<div class="track"><span class="track-title">${esc(r.title)}<small class="subline">@${esc(r.requester?.username || "listener")} · ${new Date(r.createdAt).toLocaleString()} · ${esc(r.status)}</small></span>${r.status === "pending" && viewSession?.status === "active" ? `<button class="button small" data-request-action="approved" data-request="${esc(r.id)}">Approve</button><button class="button secondary small" data-request-action="rejected" data-request="${esc(r.id)}">Reject</button>` : ""}</div>`,
          )
          .join("") || '<div class="empty">No song requests yet.</div>';
    box?.querySelectorAll("[data-request]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            await api(`/sessions/${id}/requests/${b.dataset.request}`, {
              method: "POST",
              body: JSON.stringify({ status: b.dataset.requestAction }),
            });
            toast(
              b.dataset.requestAction === "approved"
                ? "Request approved and added to queue"
                : "Request rejected",
            );
            await loadSessionRequests(id, true);
          } catch (e) {
            toast(e.message);
          } finally {
            b.disabled = false;
          }
        }),
    );
  } else {
    const box = document.querySelector("#my-requests");
    if (box)
      box.innerHTML = requests
        .map(
          (r) =>
            `<div class="track"><span class="track-title">${esc(r.title)}<small class="subline">Request status: ${esc(r.status)}</small></span></div>`,
        )
        .join("");
  }
}
async function socialSession(id) {
  const d = await api(`/sessions/${id}`),
    s = d.session;
  viewSession = s;
  viewIsHost = s.isHost;
  const hostLive = s.hostActive && s.status === "active";
  frame(
    `<div class="room-top"><div><span class="eyebrow">${s.isHost ? "YOUR SHARED SESSION" : "LISTENING SESSION"}</span><h1>${esc(s.host.name)}’s session</h1><span id="session-status" class="muted" style="font-size:12px">${s.status === "ended" ? "Host left · playback is independent" : s.audience === "off" ? "Sharing is off · existing listeners can stay" : hostLive ? "Live sync · " + esc(s.audience) : "Host connection ended · playback is independent"}</span></div><button class="button secondary small" id="session-leave">${s.isHost ? "End session" : "Leave session"}</button></div><div class="room-layout"><div class="card"><div class="card-head"><h2>${esc(s.title || "Now playing")}</h2><span class="badge">${s.playback === "playing" && hostLive ? "PLAYING" : "PAUSED"}</span></div><div class="player">${s.videoId ? '<div id="yt-player"></div>' : '<div class="player-placeholder">No video selected</div>'}</div><div id="player-error" class="footer-note"></div>${s.isHost ? '<div class="track-form"><button class="button small" id="session-play">Play / Pause</button><label class="muted">Seek</label><input id="session-seek" class="input" type="range" min="0" max="100" value="0"></div>' : '<button class="button" id="activate-playback">Click to activate synchronized playback</button>'}<div id="session-participants" class="members">${s.participants.map((p) => `<span class="member-pill">${esc(p.name)}</span>`).join("")}</div><div class="section"><b>Host queue</b><div id="session-queue" class="track-list">${s.queue.map((q) => `<div class="track"><span class="track-title">${esc(q.title)}</span></div>`).join("") || '<div class="empty">Queue is empty.</div>'}</div></div>${s.isHost ? '<div class="section"><b>Song Requests</b><p id="request-count" class="footer-note">Loading pending requests…</p><div id="host-requests"></div></div>' : s.status === "active" ? '<form id="song-request" class="track-form section"><input class="input" name="url" placeholder="YouTube video link to suggest" required><button class="button small">Suggest a song</button></form><div id="my-requests" class="section"></div>' : '<p class="footer-note">Requests are closed because this session has ended.</p><div id="my-requests"></div>'}</div></div><section class="card chat-card"><div class="card-head"><h2>Session chat</h2></div><div id="session-messages" class="chat-messages">${s.messages.map(messageHtml).join("") || '<div class="empty">No messages yet.</div>'}</div><form id="session-chat" class="chat-form"><input class="input" name="text" maxlength="500" required placeholder="Write a message…" ${s.status === "ended" ? "disabled" : ""}><button class="button small" ${s.status === "ended" ? "disabled" : ""}>Send</button></form><p class="footer-note">${s.status === "ended" ? "Chat is read-only because the host has left." : "Updates refresh every few seconds."}</p></section></div>`,
    "people",
  );
  if (s.videoId) startSocialPlayer(s.videoId, s, s.isHost);
  if (!s.isHost)
    document.querySelector("#activate-playback").onclick = () => {
      ytPlayer?.playVideo();
      applySocialState(s, true);
    };
  if (s.isHost) {
    document.querySelector("#session-play").onclick = () => {
      const st = s.playback === "playing" ? "paused" : "playing";
      ytPlayer?.[st === "playing" ? "playVideo" : "pauseVideo"]();
      sendSocialState({
        status: st,
        position: ytPlayer?.getCurrentTime?.() || s.position,
      });
    };
    document.querySelector("#session-seek").onchange = (e) => {
      ytPlayer?.seekTo(Number(e.target.value), true);
      sendSocialState({ position: Number(e.target.value) });
    };
  }
  if (s.isHost) loadSessionRequests(id, true);
  else {
    document.querySelector("#song-request").onsubmit = async (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget),
        parsed = youtubeInput(form.get("url"));
      if (!parsed || parsed.type !== "video") {
        toast("Use a valid YouTube video URL or video ID.");
        return;
      }
      const button = e.currentTarget.querySelector("button");
      button.disabled = true;
      try {
        const result = await api(`/sessions/${id}/requests`, {
          method: "POST",
          body: JSON.stringify({ videoId: parsed.id }),
        });
        toast(
          result.duplicate
            ? "That song is already pending"
            : "Song request sent",
        );
        e.currentTarget.reset();
        await loadSessionRequests(id, false);
      } catch (err) {
        toast(err.message);
      } finally {
        button.disabled = false;
      }
    };
    loadSessionRequests(id, false);
  }
  document.querySelector("#session-leave").onclick = async () => {
    if (s.isHost) await api("/corner/end", { method: "POST" });
    else await api(`/sessions/${id}/leave`, { method: "POST" });
    sessionStorage.removeItem("listeningSession");
    location.hash = "#corner";
  };
  document.querySelector("#session-chat").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const text = new FormData(e.currentTarget).get("text");
      await api(`/sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      e.currentTarget.reset();
    } catch (err) {
      toast(err.message);
    }
  };
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const h = await api(`/sessions/${id}/heartbeat`, { method: "POST" });
      const fresh = h.session;
      if (fresh.videoId !== s.videoId || fresh.title !== s.title) {
        socialSession(id);
        return;
      }
      s.status = fresh.status;
      s.audience = fresh.audience;
      viewSession = fresh;
      const playbackBadge = document.querySelector(".card-head .badge");
      if (playbackBadge)
        playbackBadge.textContent =
          fresh.playback === "playing" && fresh.hostActive
            ? "PLAYING"
            : "PAUSED";
      const statusLabel = document.querySelector("#session-status");
      if (statusLabel)
        statusLabel.textContent =
          fresh.status === "ended"
            ? "Host left · playback is independent"
            : !fresh.hostActive
              ? "Host connection ended · playback is independent"
              : fresh.audience === "off"
                ? "Sharing is off · existing listeners can stay"
                : "Live sync · " + fresh.audience;
      const chatInput = document.querySelector("#session-chat input");
      const chatButton = document.querySelector("#session-chat button");
      if (fresh.status === "ended") {
        if (chatInput) chatInput.disabled = true;
        if (chatButton) chatButton.disabled = true;
      }
      applySocialState(fresh);
      const participants = document.querySelector("#session-participants");
      if (participants)
        participants.innerHTML = fresh.participants
          .map((p) => `<span class="member-pill">${esc(p.name)}</span>`)
          .join("");
      const queue = document.querySelector("#session-queue");
      if (queue)
        queue.innerHTML =
          fresh.queue
            .map(
              (q) =>
                `<div class="track"><span class="track-title">${esc(q.title)}</span></div>`,
            )
            .join("") || '<div class="empty">Queue is empty.</div>';
      loadSessionRequests(id, fresh.isHost).catch(() => {});
      if (
        fresh.isHost &&
        fresh.playback === "playing" &&
        ytPlayer?.getCurrentTime &&
        Date.now() - lastSyncPost > 4000
      ) {
        lastSyncPost = Date.now();
        await api(`/sessions/${id}/play`, {
          method: "POST",
          body: JSON.stringify({ position: ytPlayer.getCurrentTime() || 0 }),
        });
      }
      const messages = await api(`/sessions/${id}/messages`);
      const el = document.querySelector("#session-messages");
      if (el && messages.messages.length !== s.messages.length)
        el.innerHTML = messages.messages.map(messageHtml).join("");
    } catch {}
  }, 2500);
}
async function render() {
  clearInterval(poll);
  clearInterval(cornerTimer);
  const route = decodeURIComponent(location.hash.slice(1) || "home");
  if (route === "login" || route === "signup") {
    me = null;
    authView(route === "signup");
    return;
  }
  try {
    me = (await api("/me")).user;
  } catch {
    if (
      route.startsWith("room/") ||
      route.startsWith("session/") ||
      route === "profile" ||
      route.startsWith("profile/")
    ) {
      location.hash = "#login";
      return;
    }
    authView(false);
    return;
  }
  try {
    if (route === "home") await home();
    else if (route === "corner") await corner();
    else if (route === "people") await peoples();
    else if (route === "discover") await discover();
    else if (route === "profile") await profile();
    else if (route.startsWith("profile/")) await profile(route.slice(8));
    else if (route.startsWith("room/")) await room(route.slice(5));
    else if (route.startsWith("session/")) await socialSession(route.slice(8));
    else {
      location.hash = "#home";
    }
  } catch (e) {
    frame(
      `<div class="empty">${esc(e.message)} <a href="#home" style="color:var(--lime)">Go home</a></div>`,
    );
  }
}
window.addEventListener("hashchange", render);
render();
