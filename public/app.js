// ============================================================
// Prank Call — Voice Chat Lobby (with lobby codes)
// ============================================================
// Firebase Realtime Database for presence + lobby signaling
// PeerJS (WebRTC) for peer-to-peer voice calls
// ============================================================

// ---------- Firebase Config ----------
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- App State ----------
const state = {
  userId: null,
  userName: null,
  lobbyCode: null,
  isHost: false,
  peer: null,
  currentCall: null,
  localStream: null,
  remoteAudio: null,
  callTimerInterval: null,
  callStartTime: null,
  incomingTimeout: null,
  callingTimeout: null,
};

// ---------- DOM Cache ----------
const $ = (sel) => document.querySelector(sel);
const screens = { landing: null, choice: null, lobby: null, call: null, calling: null };
let nameModal, joinModal, incomingOverlay, toast, lobbyGrid;

// ---------- Helpers ----------
function generateId() {
  return "user_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

const LOBBY_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateLobbyCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += LOBBY_CHARS[Math.floor(Math.random() * LOBBY_CHARS.length)];
  }
  return code;
}

function getInitials(name) {
  return name.split(/\s+/).map((w) => w[0]).join("").toUpperCase().substring(0, 2);
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  if (screens[name]) screens[name].classList.add("active");
}

function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), duration);
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Scoped Firebase refs
function usersRef() { return db.ref("lobbies/" + state.lobbyCode + "/users"); }
function userRef(uid) { return db.ref("lobbies/" + state.lobbyCode + "/users/" + (uid || state.userId)); }
function callReqRef(uid) { return db.ref("lobbies/" + state.lobbyCode + "/callRequests/" + (uid || state.userId)); }
function lobbyMetaRef() { return db.ref("lobbies/" + state.lobbyCode + "/meta"); }
function lobbyRootRef() { return db.ref("lobbies/" + state.lobbyCode); }

// ---------- Step 1: Landing ----------
function initLanding() {
  $("#phone-icon-btn").addEventListener("click", () => {
    nameModal.classList.add("active");
    $("#name-input").focus();
  });
}

// ---------- Step 2: Name Submit → Choice Screen ----------
function submitName() {
  const name = $("#name-input").value.trim();
  if (!name) { showToast("Please enter a name"); return; }

  state.userName = name;
  state.userId = generateId();
  nameModal.classList.remove("active");

  $("#choice-user-name").textContent = name;
  showScreen("choice");
}

// ---------- Step 3a: Create Lobby ----------
async function createLobby() {
  let code = generateLobbyCode();

  try {
    // Check for collision (extremely unlikely)
    const snap = await lobbyRootRefForCode(code).once("value");
    if (snap.exists()) code = generateLobbyCode();

    state.lobbyCode = code;
    state.isHost = true;

    // Write lobby metadata
    await db.ref("lobbies/" + code + "/meta").set({
      hostId: state.userId,
      hostName: state.userName,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });

    enterLobby();
  } catch (err) {
    console.error("createLobby error:", err);
    showToast("Failed to create lobby. Check Firebase config.");
  }
}

function lobbyRootRefForCode(code) {
  return db.ref("lobbies/" + code);
}

// ---------- Step 3b: Join Lobby by Code ----------
async function joinLobbyByCode() {
  const input = $("#lobby-code-input").value.trim().toUpperCase();
  if (input.length !== 6) { showToast("Code must be 6 characters"); return; }

  try {
    // Check lobby exists and has users or meta
    const metaSnap = await db.ref("lobbies/" + input + "/meta").once("value");
    if (!metaSnap.exists()) { showToast("Lobby not found"); return; }

    state.lobbyCode = input;
    state.isHost = false;
    joinModal.classList.remove("active");

    enterLobby();
  } catch (err) {
    console.error("joinLobbyByCode error:", err);
    showToast("Failed to join lobby. Check Firebase config.");
  }
}

// ---------- Enter Lobby (shared by create & join) ----------
function enterLobby() {
  showScreen("lobby");
  $("#lobby-user-name").textContent = state.userName;
  $("#lobby-code-text").textContent = state.lobbyCode;

  // Write presence
  const ref = userRef();
  ref.set({
    name: state.userName,
    status: "available",
    isHost: state.isHost,
    joinedAt: firebase.database.ServerValue.TIMESTAMP,
  });
  ref.onDisconnect().remove();

  // Init PeerJS
  state.peer = new Peer(state.userId, { debug: 0 });
  state.peer.on("error", (err) => {
    console.error("PeerJS error:", err);
    if (err.type === "unavailable-id") {
      showToast("Connection conflict. Refreshing...");
      setTimeout(() => location.reload(), 1500);
    }
  });
  state.peer.on("call", handleIncomingPeerCall);

  listenLobby();
  listenCallRequests();
  watchOwnStatus();
}

// ---------- Leave Lobby ----------
function leaveLobby() {
  if (state.currentCall) { state.currentCall.close(); state.currentCall = null; }
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  if (state.remoteAudio) { state.remoteAudio.pause(); state.remoteAudio.srcObject = null; state.remoteAudio = null; }
  if (state.callTimerInterval) { clearInterval(state.callTimerInterval); state.callTimerInterval = null; }
  if (state.incomingTimeout) { clearTimeout(state.incomingTimeout); state.incomingTimeout = null; }
  if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }

  if (state.lobbyCode) {
    usersRef().off();
    userRef().off();
    callReqRef().off();
    userRef().remove();
    callReqRef().remove();

    // Clean up empty lobby
    const code = state.lobbyCode;
    usersRef().once("value", (snap) => {
      if (!snap.exists() || snap.numChildren() === 0) {
        db.ref("lobbies/" + code).remove();
      }
    });
  }

  if (state.peer) { state.peer.destroy(); state.peer = null; }

  state.userId = null;
  state.userName = null;
  state.lobbyCode = null;
  state.isHost = false;

  incomingOverlay.classList.remove("active");
  showScreen("landing");
  $("#name-input").value = "";
  $("#lobby-code-input").value = "";
}

// ---------- Lobby Rendering ----------
function listenLobby() {
  usersRef().on("value", (snapshot) => {
    renderLobby(snapshot.val() || {});
  });
}

function renderLobby(users) {
  lobbyGrid.innerHTML = "";
  const ids = Object.keys(users);

  ids.sort((a, b) => {
    if (a === state.userId) return -1;
    if (b === state.userId) return 1;
    return users[a].name.localeCompare(users[b].name);
  });

  if (ids.length <= 1 && ids[0] === state.userId) {
    renderUserCard(ids[0], users[ids[0]]);
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = "Share the code to invite others!";
    lobbyGrid.appendChild(empty);
    return;
  }

  if (ids.length === 0) {
    lobbyGrid.innerHTML = '<div class="lobby-empty">Waiting for others to join...</div>';
    return;
  }

  ids.forEach((id) => renderUserCard(id, users[id]));
}

function renderUserCard(id, user) {
  const isSelf = id === state.userId;
  const isAvailable = user.status === "available";
  const isInCall = user.status === "in-call";
  const isCalling = user.status === "calling";

  const card = document.createElement("div");
  card.className = "user-card";
  if (isSelf) card.classList.add("is-you");
  else if (isAvailable) card.classList.add("clickable");
  else card.classList.add("busy");

  let statusClass = "available";
  let statusLabel = "Available";
  if (isInCall) { statusClass = "in-call"; statusLabel = "In a call"; }
  else if (isCalling) { statusClass = "calling"; statusLabel = "Calling..."; }

  const labels = [];
  if (user.isHost) labels.push('<div class="host-label">Host</div>');
  if (isSelf) labels.push('<div class="you-label">You</div>');

  card.innerHTML = `
    <div class="avatar" style="background:${avatarColor(user.name)}">${getInitials(user.name)}</div>
    <div class="user-name">${escapeHtml(user.name)}</div>
    ${labels.join("")}
    <div class="status-badge ${statusClass}">
      <span class="status-dot"></span>
      ${statusLabel}
    </div>
  `;

  if (!isSelf && isAvailable) {
    card.addEventListener("click", () => initiateCall(id, user.name));
  }

  lobbyGrid.appendChild(card);
}

// ---------- Call Requests ----------
function listenCallRequests() {
  callReqRef().on("value", (snapshot) => {
    const req = snapshot.val();
    if (req && req.from) showIncomingCall(req.from, req.fromName);
  });
}

function initiateCall(targetId, targetName) {
  userRef().update({ status: "calling" });

  db.ref("lobbies/" + state.lobbyCode + "/callRequests/" + targetId).set({
    from: state.userId,
    fromName: state.userName,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  });

  $("#calling-target-name").textContent = targetName;
  showScreen("calling");

  const targetUserRef = userRef(targetId);
  const onTargetChange = (snap) => {
    if (!snap.val()) {
      cancelOutgoingCall(targetId);
      targetUserRef.off("value", onTargetChange);
    }
  };
  targetUserRef.on("value", onTargetChange);

  state.callingTimeout = setTimeout(() => {
    cancelOutgoingCall(targetId);
    targetUserRef.off("value", onTargetChange);
    showToast("No answer");
  }, 25000);

  const cancelBtn = $("#btn-cancel-call");
  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  newCancelBtn.addEventListener("click", () => {
    cancelOutgoingCall(targetId);
    targetUserRef.off("value", onTargetChange);
  });
}

function cancelOutgoingCall(targetId) {
  if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
  db.ref("lobbies/" + state.lobbyCode + "/callRequests/" + targetId).remove();
  if (state.userId) userRef().update({ status: "available" });
  showScreen("lobby");
}

// ---------- Incoming Call ----------
function showIncomingCall(fromId, fromName) {
  if (incomingOverlay.classList.contains("active")) return;
  incomingOverlay.classList.add("active");
  $("#incoming-caller-name").textContent = fromName;

  let countdown = 20;
  const countdownEl = $("#incoming-countdown");
  countdownEl.textContent = `Auto-declining in ${countdown}s`;
  const countdownInterval = setInterval(() => {
    countdown--;
    countdownEl.textContent = `Auto-declining in ${countdown}s`;
    if (countdown <= 0) clearInterval(countdownInterval);
  }, 1000);

  state.incomingTimeout = setTimeout(() => {
    declineCall(fromId);
    clearInterval(countdownInterval);
  }, 20000);

  const acceptBtn = $("#btn-accept-call");
  const declineBtn = $("#btn-decline-call");
  const newAcceptBtn = acceptBtn.cloneNode(true);
  const newDeclineBtn = declineBtn.cloneNode(true);
  acceptBtn.parentNode.replaceChild(newAcceptBtn, acceptBtn);
  declineBtn.parentNode.replaceChild(newDeclineBtn, declineBtn);

  newAcceptBtn.addEventListener("click", () => {
    clearTimeout(state.incomingTimeout); clearInterval(countdownInterval);
    acceptCall(fromId, fromName);
  });
  newDeclineBtn.addEventListener("click", () => {
    clearTimeout(state.incomingTimeout); clearInterval(countdownInterval);
    declineCall(fromId);
  });
}

function declineCall(fromId) {
  incomingOverlay.classList.remove("active");
  callReqRef().remove();
  userRef(fromId).once("value", (snap) => {
    if (snap.val() && snap.val().status === "calling") {
      userRef(fromId).update({ status: "available" });
    }
  });
}

async function acceptCall(fromId, fromName) {
  incomingOverlay.classList.remove("active");

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    showToast("Microphone access denied. Cannot start call.");
    callReqRef().remove();
    userRef(fromId).once("value", (snap) => {
      if (snap.val() && snap.val().status === "calling") {
        userRef(fromId).update({ status: "available" });
      }
    });
    return;
  }

  userRef().update({ status: "in-call", callPartner: fromId });
  userRef(fromId).update({ status: "in-call", callPartner: state.userId });
  callReqRef().remove();
  startCallScreen(fromName);
}

// ---------- PeerJS Voice ----------
function handleIncomingPeerCall(call) {
  if (!state.localStream) { call.close(); return; }
  call.answer(state.localStream);
  state.currentCall = call;
  call.on("stream", (rs) => playRemoteStream(rs));
  call.on("close", () => endCall());
  call.on("error", () => endCall());
}

async function startPeerCall(targetId) {
  if (!state.peer) return;
  if (!state.localStream) {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) { showToast("Microphone access denied."); endCall(); return; }
  }
  const call = state.peer.call(targetId, state.localStream);
  if (!call) { showToast("Failed to connect call"); endCall(); return; }
  state.currentCall = call;
  call.on("stream", (rs) => playRemoteStream(rs));
  call.on("close", () => endCall());
  call.on("error", () => endCall());
}

function playRemoteStream(stream) {
  if (!state.remoteAudio) {
    state.remoteAudio = document.createElement("audio");
    state.remoteAudio.autoplay = true;
    document.body.appendChild(state.remoteAudio);
  }
  state.remoteAudio.srcObject = stream;
}

// ---------- Call Screen ----------
function startCallScreen(partnerName) {
  showScreen("call");
  $("#call-partner-name").textContent = partnerName;
  state.callStartTime = Date.now();
  $("#call-timer").textContent = "00:00";
  state.callTimerInterval = setInterval(() => {
    $("#call-timer").textContent = formatTime(Math.floor((Date.now() - state.callStartTime) / 1000));
  }, 1000);

  const hangupBtn = $("#btn-hangup");
  const newHangup = hangupBtn.cloneNode(true);
  hangupBtn.parentNode.replaceChild(newHangup, hangupBtn);
  newHangup.addEventListener("click", () => endCall());
}

function endCall() {
  if (state.currentCall) { state.currentCall.close(); state.currentCall = null; }
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  if (state.remoteAudio) { state.remoteAudio.pause(); state.remoteAudio.srcObject = null; }
  if (state.callTimerInterval) { clearInterval(state.callTimerInterval); state.callTimerInterval = null; }
  if (state.userId && state.lobbyCode) {
    userRef().update({ status: "available", callPartner: null });
  }
  if (state.userId) showScreen("lobby");
}

// ---------- Watch Own Status (caller side) ----------
function watchOwnStatus() {
  userRef().on("value", (snap) => {
    const data = snap.val();
    if (!data) return;

    if (data.status === "in-call" && data.callPartner && screens.calling.classList.contains("active")) {
      if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
      const partnerId = data.callPartner;
      userRef(partnerId).once("value", (pSnap) => {
        const pData = pSnap.val();
        startCallScreen(pData ? pData.name : "Unknown");
        startPeerCall(partnerId);
      });
    }

    if (data.status === "available" && screens.calling.classList.contains("active")) {
      if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
      showToast("Call was declined");
      showScreen("lobby");
    }
  });
}

// ---------- Copy Code ----------
function copyLobbyCode() {
  if (!state.lobbyCode) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(state.lobbyCode).then(() => showToast("Code copied!"));
  } else {
    const ta = document.createElement("textarea");
    ta.value = state.lobbyCode;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Code copied!");
  }
}

// ---------- Initialization ----------
document.addEventListener("DOMContentLoaded", () => {
  screens.landing = $("#landing-screen");
  screens.choice = $("#choice-screen");
  screens.lobby = $("#lobby-screen");
  screens.call = $("#call-screen");
  screens.calling = $("#calling-screen");
  nameModal = $("#name-modal");
  joinModal = $("#join-modal");
  incomingOverlay = $("#incoming-call-overlay");
  toast = $("#toast");
  lobbyGrid = $("#lobby-grid");

  // Landing
  initLanding();

  // Name modal
  $("#name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
  $("#btn-name-submit").addEventListener("click", submitName);

  // Choice screen
  $("#btn-create-lobby").addEventListener("click", createLobby);
  $("#btn-join-lobby").addEventListener("click", () => {
    joinModal.classList.add("active");
    $("#lobby-code-input").focus();
  });

  // Join modal
  $("#lobby-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinLobbyByCode(); });
  $("#btn-submit-code").addEventListener("click", joinLobbyByCode);
  $("#btn-back-to-choice").addEventListener("click", () => {
    joinModal.classList.remove("active");
  });

  // Lobby
  $("#btn-leave").addEventListener("click", leaveLobby);
  $("#btn-copy-code").addEventListener("click", copyLobbyCode);
});

// Page unload cleanup
window.addEventListener("beforeunload", () => {
  if (state.userId && state.lobbyCode) {
    userRef().remove();
    callReqRef().remove();
  }
});
