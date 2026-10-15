# Manhunt

A website for running a real-life manhunt game from your phones.

- **Lobbies**: create one (you get a 5-character code + invite link) or join with a code.
- **Roles**: the host picks hunters/runners manually or randomises them.
- **Forced quests**: the host sets the quests the runners must complete to win, and chooses whether
  they can be done in any order or must follow the order the host sets (↑/↓ to reorder). They're shared
  by the team — any free runner can complete one. If every runner is caught first, hunters win.
- **Bonus quests**: optional quests with point values, used to earn points for travel.
- **Approval**: runners mark quests done (with an optional proof note); the host approves them
  (can be switched off so completions are instant).
- **Transport**: only bus and tube. The host sets a points price per stop for each; runners enter
  how many stops they're riding and pay stops × price.
- **Hunters see everything**: forced-quest progress, every runner's points, completed quests (with notes),
  journeys taken, and a live feed of events.

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
