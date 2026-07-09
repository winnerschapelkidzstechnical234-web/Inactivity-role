# Recording Crew Activity Bot

A separate bot that tracks who's joining your recording session VCs, and who's gone quiet.

## Commands

**`!inactivity`**
Lists everyone with your Recording Crew role, sorted worst-first — most inactive at the top:
- ⛔ **Never joined** — flagged clearly for anyone who's never shown up to a tracked VC
- 🔸 **Xd Xh ago** — everyone else, showing how long since they last joined

**`!lastseen @user`**
Quick check on a single person.

Both commands are restricted to whichever roles you list in `ALLOWED_ROLE_ID` (or Manage Roles permission if you leave that blank).

There are no automatic DMs or warnings — this bot only reports. What you do with that info (like removing inactive members) is entirely up to you and your team.

---

## Setup (one-time)

### 1. Create a brand new bot application
This needs to be a **separate** application from your other bot, since it's a separate bot account.
1. Go to https://discord.com/developers/applications → **New Application** → name it something like "Activity Tracker"
2. **Bot** tab → **Reset Token** → copy the token, save it somewhere safe
3. Turn ON:
   - **Server Members Intent**
   - **Message Content Intent**
4. **OAuth2 → URL Generator** → check `bot` scope. Under Bot Permissions check:
   - **View Channels**
   - **Send Messages**
   - **Read Message History**
   - **Connect** (under Voice Permissions — lets it see who's in voice channels, though it never actually joins one)
5. Copy the generated URL, open it in your browser, invite it to your server

### 2. Get your IDs
Turn on Developer Mode first: Discord Settings → Advanced → Developer Mode.

- **Voice channel ID(s):** right-click each VC you consider a "recording session" → Copy Channel ID
- **Recording Crew role ID:** right-click the role in Server Settings → Roles → Copy Role ID
- **Staff role ID(s)** (who's allowed to run the commands): same process

### 3. Set up the repo
1. Create a new GitHub repo (e.g. `discord-activity-bot`), upload these 4 files: `index.js`, `package.json`, `.env.example`, `README.md`
2. Go to Railway.app → **New Project** → **Deploy from GitHub repo** → select this new repo
3. In the project's **Variables** tab, add:
   - `DISCORD_TOKEN` → your new bot's token
   - `PREFIX` → `!`
   - `TRACKED_VC_IDS` → your VC channel ID(s), comma-separated if more than one
   - `TRACKED_ROLE_ID` → your Recording Crew role ID
   - `ALLOWED_ROLE_ID` → your staff role ID(s), comma-separated if more than one

### 4. Make activity data permanent (important)
By default, activity data is saved to a file inside the bot's container — which Railway wipes every time the bot redeploys (like when you push a code update). For real long-term tracking, add a persistent Volume:

1. In Railway, go to your service → **Settings** tab → **Volumes** → **New Volume**
2. Set the mount path to `/data`
3. Add a new variable: `DATA_DIR` → `/data`
4. Redeploy

Without this step, the bot still works fine day-to-day — you'll just lose historical join data whenever you push an update to the code.

### 5. Run it
Railway auto-installs dependencies and runs `npm start`. Check the deploy logs for `Logged in as YourBotName#0000` to confirm it's live.

---

## Notes
- This bot needs to actually be online and connected whenever someone joins the tracked VC to log it — it can't retroactively see past joins from before it was set up.
- If you add more recording VCs later, just update `TRACKED_VC_IDS` in Railway with the new channel ID added to the comma-separated list.
