# Manhunt

A website for running a real-life manhunt game from your phones.

- **Lobbies**: create one (you get a 5-character code + invite link) or join with a code.
- **Roles**: the host picks hunters/runners manually or randomises them.
- **Objective**: the host sets the item runners must retrieve and where to deliver it.
  Runners tap "I've got the item" → "Delivered it!" to win. If every runner is caught, hunters win.
- **Quests**: the host adds quests with point values. Runners mark them done (with an optional
  proof note); the host approves them (can be switched off so points are instant).
- **Transport**: the host sets the point cost of each transport (Lime bike, bus, train…).
  Runners spend points to "use" one.
- **Hunters see everything**: every runner's points, completed quests (with notes), transport used,
  and a live feed of events.

## Run it

Needs only Python 3 (no packages to install).

```
python server.py
```

Open http://localhost:8000. Friends on the same Wi-Fi can use the LAN address printed in the console.

## Playing outdoors (over mobile data)

Your friends need a public URL. Two easy options:

1. **Free hosting (recommended)**: push this folder to GitHub, then create a *Web Service* on
   [Render](https://render.com) (or Railway / Fly.io) with start command `python server.py`.
   The `PORT` environment variable is picked up automatically.
2. **Tunnel from your PC**: run `python server.py` and then e.g. `cloudflared tunnel --url http://localhost:8000`
   to get a temporary public link. Your PC has to stay on during the game.

Game state is saved to `lobbies.json`, so restarting the server won't lose a game in progress
(on free hosts with no persistent disk, a redeploy will clear it). Idle lobbies are removed after 48 hours.
