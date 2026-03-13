// ============================================================
// Prank Call — Voice Chat Lobby
// ============================================================
// Socket.IO for lobby presence & call signaling
// PeerJS (WebRTC) for peer-to-peer voice calls
// ============================================================

const socket = io();

// ---------- App State ----------
const state = {
  mySocketId: null,
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
  currentCallerId: null,   // who is calling us (incoming)
  currentTargetId: null,   // who we are calling (outgoing)
  currentPartnerId: null,  // who we are in-call with
  currentPartnerName: null,
};

// ---------- DOM Cache ----------
const $ = (sel) => document.querySelector(sel);
const screens = { home: null, lobby: null, call: null, calling: null };
let incomingOverlay, toast, lobbyGrid;

// ---------- Helpers ----------
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

// ---------- Socket.IO Event Handlers ----------

socket.on("connect", () => {
  state.mySocketId = socket.id;
});

socket.on("error", (data) => {
  showToast(data.message || "An error occurred");
});

socket.on("roomCreated", ({ code }) => {
  state.lobbyCode = code;
  state.isHost = true;
  enterLobbyScreen();
});

socket.on("roomJoined", ({ code }) => {
  state.lobbyCode = code;
  state.isHost = false;
  enterLobbyScreen();
});

socket.on("lobbyState", ({ code, players }) => {
  renderLobby(players);
});

socket.on("incomingCall", ({ callerId, callerName }) => {
  showIncomingCall(callerId, callerName);
});

socket.on("callAccepted", ({ targetId, targetName }) => {
  // We are the caller, callee accepted — start PeerJS call
  if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
  state.currentPartnerId = targetId;
  state.currentPartnerName = targetName;
  startCallScreen(targetName);
  startPeerCall(targetId);
});

socket.on("callDeclined", () => {
  if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
  state.currentTargetId = null;
  showToast("Call was declined");
  showScreen("lobby");
});

socket.on("callEnded", () => {
  endCallLocal();
});

socket.on("callCancelled", () => {
  // Caller cancelled before we answered
  if (incomingOverlay.classList.contains("active")) {
    if (state.incomingTimeout) { clearTimeout(state.incomingTimeout); state.incomingTimeout = null; }
    incomingOverlay.classList.remove("active");
    state.currentCallerId = null;
  }
});

// ---------- (Landing removed — single home screen) ----------

// ---------- Create Lobby ----------
function createLobby() {
  const name = $("#name-input").value.trim();
  if (!name) { showToast("Please enter a name"); return; }
  state.userName = name;
  socket.emit("createRoom", { name });
}

// ---------- Join Lobby by Code ----------
function joinLobbyByCode() {
  const name = $("#name-input").value.trim();
  if (!name) { showToast("Please enter a name"); return; }
  const input = $("#lobby-code-input").value.trim().toUpperCase();
  if (input.length !== 4) { showToast("Code must be 4 characters"); return; }
  state.userName = name;
  socket.emit("joinRoom", { code: input, name });
}

// ---------- Enter Lobby Screen (shared) ----------
function enterLobbyScreen() {
  showScreen("lobby");
  $("#lobby-user-name").textContent = state.userName;
  $("#lobby-code-text").textContent = state.lobbyCode;

  // Initialize PeerJS with socket ID as peer ID
  if (state.peer) { state.peer.destroy(); }
  state.peer = new Peer(socket.id, { debug: 0 });
  state.peer.on("error", (err) => {
    console.error("PeerJS error:", err);
  });
  state.peer.on("call", handleIncomingPeerCall);
}

// ---------- Leave Lobby ----------
function leaveLobby() {
  endCallLocal();
  socket.emit("leaveLobby");
  if (state.peer) { state.peer.destroy(); state.peer = null; }
  state.lobbyCode = null;
  state.isHost = false;
  state.userName = null;
  incomingOverlay.classList.remove("active");
  showScreen("home");
  $("#name-input").value = "";
  $("#lobby-code-input").value = "";
}

// ---------- Lobby Rendering ----------
function renderLobby(players) {
  lobbyGrid.innerHTML = "";

  // Sort: self first, then alphabetically
  const sorted = [...players].sort((a, b) => {
    if (a.id === socket.id) return -1;
    if (b.id === socket.id) return 1;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length <= 1 && sorted[0] && sorted[0].id === socket.id) {
    renderUserCard(sorted[0]);
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = "Share the code to invite others!";
    lobbyGrid.appendChild(empty);
    return;
  }

  if (sorted.length === 0) {
    lobbyGrid.innerHTML = '<div class="lobby-empty">Waiting for others to join...</div>';
    return;
  }

  sorted.forEach((p) => renderUserCard(p));
}

function renderUserCard(player) {
  const isSelf = player.id === socket.id;
  const isAvailable = player.status === "available";
  const isInCall = player.status === "in-call";
  const isCalling = player.status === "calling";

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
  if (player.isHost) labels.push('<div class="host-label">Host</div>');
  if (isSelf) labels.push('<div class="you-label">You</div>');

  card.innerHTML = `
    <div class="avatar" style="background:${avatarColor(player.name)}">${getInitials(player.name)}</div>
    <div class="user-name">${escapeHtml(player.name)}</div>
    ${labels.join("")}
    <div class="status-badge ${statusClass}">
      <span class="status-dot"></span>
      ${statusLabel}
    </div>
  `;

  if (!isSelf && isAvailable) {
    card.addEventListener("click", () => initiateCall(player.id, player.name));
  }

  lobbyGrid.appendChild(card);
}

// ---------- Initiate Call (caller side) ----------
function initiateCall(targetId, targetName) {
  state.currentTargetId = targetId;
  socket.emit("callUser", { targetId });

  $("#calling-target-name").textContent = targetName;
  showScreen("calling");

  // Auto-cancel after 25 seconds
  state.callingTimeout = setTimeout(() => {
    cancelOutgoingCall();
    showToast("No answer");
  }, 25000);

  // Cancel button
  const cancelBtn = $("#btn-cancel-call");
  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  newCancelBtn.addEventListener("click", () => cancelOutgoingCall());
}

function cancelOutgoingCall() {
  if (state.callingTimeout) { clearTimeout(state.callingTimeout); state.callingTimeout = null; }
  socket.emit("cancelCall");
  state.currentTargetId = null;
  showScreen("lobby");
}

// ---------- Incoming Call ----------
function showIncomingCall(callerId, callerName) {
  if (incomingOverlay.classList.contains("active")) return;
  state.currentCallerId = callerId;
  incomingOverlay.classList.add("active");
  $("#incoming-caller-name").textContent = callerName;

  let countdown = 20;
  const countdownEl = $("#incoming-countdown");
  countdownEl.textContent = `Auto-declining in ${countdown}s`;
  const countdownInterval = setInterval(() => {
    countdown--;
    countdownEl.textContent = `Auto-declining in ${countdown}s`;
    if (countdown <= 0) clearInterval(countdownInterval);
  }, 1000);

  state.incomingTimeout = setTimeout(() => {
    declineCall();
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
    acceptCall(callerId, callerName);
  });
  newDeclineBtn.addEventListener("click", () => {
    clearTimeout(state.incomingTimeout); clearInterval(countdownInterval);
    declineCall();
  });
}

async function acceptCall(callerId, callerName) {
  incomingOverlay.classList.remove("active");

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    showToast("Microphone access denied. Cannot start call.");
    socket.emit("declineCall", { callerId });
    state.currentCallerId = null;
    return;
  }

  state.currentPartnerId = callerId;
  state.currentPartnerName = callerName;
  state.currentCallerId = null;

  socket.emit("acceptCall", { callerId });
  startCallScreen(callerName);
  // Callee waits for PeerJS call from the caller (handled by peer.on("call"))
}

function declineCall() {
  incomingOverlay.classList.remove("active");
  if (state.currentCallerId) {
    socket.emit("declineCall", { callerId: state.currentCallerId });
    state.currentCallerId = null;
  }
}

// ---------- PeerJS Voice ----------
function handleIncomingPeerCall(call) {
  if (!state.localStream) { call.close(); return; }
  call.answer(state.localStream);
  state.currentCall = call;
  call.on("stream", (rs) => playRemoteStream(rs));
  call.on("close", () => endCallLocal());
  call.on("error", () => endCallLocal());
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
  call.on("close", () => endCallLocal());
  call.on("error", () => endCallLocal());
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

// End call (initiated by us — notify server)
function endCall() {
  socket.emit("endCall");
  endCallLocal();
}

// End call locally (cleanup streams/UI — called by both sides)
function endCallLocal() {
  if (state.currentCall) { state.currentCall.close(); state.currentCall = null; }
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  if (state.remoteAudio) { state.remoteAudio.pause(); state.remoteAudio.srcObject = null; }
  if (state.callTimerInterval) { clearInterval(state.callTimerInterval); state.callTimerInterval = null; }
  state.currentPartnerId = null;
  state.currentPartnerName = null;
  state.currentTargetId = null;
  if (state.lobbyCode) showScreen("lobby");
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
  screens.home = $("#home-screen");
  screens.lobby = $("#lobby-screen");
  screens.call = $("#call-screen");
  screens.calling = $("#calling-screen");
  incomingOverlay = $("#incoming-call-overlay");
  toast = $("#toast");
  lobbyGrid = $("#lobby-grid");

  // Home screen
  $("#btn-create-lobby").addEventListener("click", createLobby);
  $("#btn-join-lobby").addEventListener("click", joinLobbyByCode);
  $("#lobby-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinLobbyByCode(); });

  // Lobby
  $("#btn-leave").addEventListener("click", leaveLobby);
  $("#btn-copy-code").addEventListener("click", copyLobbyCode);
});
