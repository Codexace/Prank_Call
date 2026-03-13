# Prank Call

A real-time voice chat lobby with shareable lobby codes. A host creates a lobby, gets a 6-character code, and shares it with others to join. Once in the lobby, users can click on any available person to start a private one-on-one voice call.

## Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript (no build tools)
- **Server:** Node.js + Express (serves static files)
- **Presence/Lobby:** Firebase Realtime Database (free tier)
- **Voice Calls:** PeerJS (WebRTC, peer-to-peer audio)

## How It Works

1. **Landing** — Click the phone icon, enter your display name
2. **Choice** — Choose to **Create Lobby** or **Join Lobby**
3. **Create** — Generates a unique 6-character lobby code. Share it with others!
4. **Join** — Enter a lobby code to join an existing lobby
5. **Lobby** — See all connected users and their status (Available / In a call / Host)
6. **Call** — Click an available user to call them; they can Accept or Decline
7. **Voice** — PeerJS handles peer-to-peer WebRTC audio
8. **Hang Up** — Either party ends the call; both return to the lobby

Firebase `onDisconnect()` automatically removes users who close their browser tab. Empty lobbies are cleaned up automatically.

## Setup

### 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** and follow the steps
3. In the project dashboard, click the **Web** icon (`</>`) to register a web app
4. Copy the `firebaseConfig` object

### 2. Configure Firebase

Open `public/app.js` and replace the placeholder `firebaseConfig` at the top:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### 3. Set Firebase Realtime Database Rules

In Firebase Console → **Realtime Database → Rules**:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

> **Note:** These open rules are fine for development. For production, add proper security rules.

### 4. Run Locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

### 5. Deploy to Render.com

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com/)
3. Click **New → Web Service**
4. Connect your GitHub repo
5. Set the following:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Deploy!

Render will automatically assign a URL like `https://your-app.onrender.com`.

### 6. Testing Voice Calls

Open the site in two separate browser tabs (or devices). Create a lobby in one, copy the code, join from the other. Click on the other user to start a call. Allow microphone access when prompted.
