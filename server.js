const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ---------- In-memory room storage ----------
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function broadcastLobby(room) {
  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    isHost: p.isHost,
  }));
  io.to(room.code).emit("lobbyState", { code: room.code, players });
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.id === socketId);
    if (player) return room;
  }
  return null;
}

function removePlayerFromRoom(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return;

  // If in a call, end the call for the partner too
  const player = room.players.find((p) => p.id === socketId);
  if (player && player.status === "in-call" && player.callPartner) {
    const partner = room.players.find((p) => p.id === player.callPartner);
    if (partner) {
      partner.status = "available";
      partner.callPartner = null;
      io.to(partner.id).emit("callEnded");
    }
  }
  // If calling someone, notify them
  if (player && player.status === "calling" && player.callTarget) {
    io.to(player.callTarget).emit("callCancelled");
  }

  room.players = room.players.filter((p) => p.id !== socketId);

  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    // If host left, promote next player
    if (room.hostId === socketId) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }
    broadcastLobby(room);
  }
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  // --- Create Room ---
  socket.on("createRoom", ({ name }) => {
    if (!name || typeof name !== "string") {
      socket.emit("error", { message: "Name is required" });
      return;
    }
    const trimmed = name.trim().substring(0, 24);
    if (!trimmed) {
      socket.emit("error", { message: "Name is required" });
      return;
    }

    const code = genCode();
    const room = {
      code,
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name: trimmed,
          status: "available",
          isHost: true,
          callPartner: null,
          callTarget: null,
        },
      ],
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;

    socket.emit("roomCreated", { code });
    broadcastLobby(room);
  });

  // --- Join Room ---
  socket.on("joinRoom", ({ code, name }) => {
    if (!code || !name) {
      socket.emit("error", { message: "Code and name are required" });
      return;
    }
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim().substring(0, 24);

    const room = rooms.get(trimmedCode);
    if (!room) {
      socket.emit("error", { message: "Lobby not found" });
      return;
    }
    if (room.players.length >= 20) {
      socket.emit("error", { message: "Lobby is full" });
      return;
    }
    if (room.players.some((p) => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      socket.emit("error", { message: "Name already taken in this lobby" });
      return;
    }

    room.players.push({
      id: socket.id,
      name: trimmedName,
      status: "available",
      isHost: false,
      callPartner: null,
      callTarget: null,
    });
    socket.join(trimmedCode);
    socket.roomCode = trimmedCode;

    socket.emit("roomJoined", { code: trimmedCode });
    broadcastLobby(room);
  });

  // --- Call User ---
  socket.on("callUser", ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const caller = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === targetId);
    if (!caller || !target) return;
    if (caller.status !== "available" || target.status !== "available") return;

    caller.status = "calling";
    caller.callTarget = targetId;

    io.to(targetId).emit("incomingCall", {
      callerId: socket.id,
      callerName: caller.name,
    });

    broadcastLobby(room);
  });

  // --- Accept Call ---
  socket.on("acceptCall", ({ callerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const caller = room.players.find((p) => p.id === callerId);
    const callee = room.players.find((p) => p.id === socket.id);
    if (!caller || !callee) return;
    if (caller.status !== "calling") return;

    caller.status = "in-call";
    caller.callPartner = socket.id;
    caller.callTarget = null;
    callee.status = "in-call";
    callee.callPartner = callerId;

    io.to(callerId).emit("callAccepted", {
      targetId: socket.id,
      targetName: callee.name,
    });

    broadcastLobby(room);
  });

  // --- Decline Call ---
  socket.on("declineCall", ({ callerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const caller = room.players.find((p) => p.id === callerId);
    if (caller && caller.status === "calling") {
      caller.status = "available";
      caller.callTarget = null;
      io.to(callerId).emit("callDeclined");
    }

    broadcastLobby(room);
  });

  // --- End Call ---
  socket.on("endCall", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.status !== "in-call") return;

    const partnerId = player.callPartner;
    player.status = "available";
    player.callPartner = null;

    if (partnerId) {
      const partner = room.players.find((p) => p.id === partnerId);
      if (partner) {
        partner.status = "available";
        partner.callPartner = null;
        io.to(partnerId).emit("callEnded");
      }
    }

    broadcastLobby(room);
  });

  // --- Cancel Outgoing Call ---
  socket.on("cancelCall", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const caller = room.players.find((p) => p.id === socket.id);
    if (!caller || caller.status !== "calling") return;

    const targetId = caller.callTarget;
    caller.status = "available";
    caller.callTarget = null;

    if (targetId) {
      io.to(targetId).emit("callCancelled");
    }

    broadcastLobby(room);
  });

  // --- Leave Lobby ---
  socket.on("leaveLobby", () => {
    if (socket.roomCode) {
      socket.leave(socket.roomCode);
    }
    removePlayerFromRoom(socket.id);
    socket.roomCode = null;
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    removePlayerFromRoom(socket.id);
  });
});

// Fallback route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`Prank Call server running on port ${PORT}`);
});
