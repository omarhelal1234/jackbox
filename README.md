# Top Match – Jackbox-style Party Game

A web-based multiplayer party game where players match answers to ranked category lists — like Family Feud meets Jackbox!

## How It Works

1. **Host** opens the game on a TV / big screen.
2. **Players** join from their phones by entering a 4-character room code.
3. Each round shows a category (e.g. *"Things you see in a classroom"*).
4. Players submit one word that fits the category.
5. The game reveals the **Top 10 answers** and awards points based on ranking.
6. Optional **Hi/Lo** twist — predict if your answer will rank in the top or bottom half for bonus points.
7. After all rounds the winner is crowned!

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open the host screen in a browser (put on a TV)
#    http://localhost:3000/host.html

# 4. Players join from their phones
#    http://localhost:3000
#    (or use the local IP to reach the server from other devices on the same network)
```

> **Tip:** To find your local IP on Windows run `ipconfig` and look for your IPv4 address, then have players visit `http://<YOUR_IP>:3000`.

## Scoring

| Rank | Points |
|------|--------|
| #1   | 1 000  |
| #2   | 800    |
| #3   | 650    |
| #4   | 500    |
| #5   | 350    |
| #6   | 250    |
| #7–10| 100    |
| Not ranked | 0 |
| Hi/Lo bonus (correct prediction) | +200 |

## Project Structure

```
Jackbox/
├── server.js             # Express + Socket.IO server
├── game/
│   ├── Room.js           # Game room class (state machine, scoring, timers)
│   └── matcher.js        # Answer normalisation & matching
├── data/
│   └── categories.json   # 30 categories × 10 ranked answers + synonyms
├── public/
│   ├── index.html        # Landing page (join / host)
│   ├── host.html         # TV / host display
│   ├── player.html       # Player phone interface
│   ├── css/
│   │   └── styles.css    # All styles (host + player + landing)
│   └── js/
│       ├── host.js       # Host client logic + reveal animations
│       ├── player.js     # Player client logic
│       └── audio.js      # Web Audio API sound effects (no files needed)
├── package.json
└── README.md
```

## Features

- **2–12 players** per room
- **Real-time sync** via Socket.IO
- **30 categories** with ranked answers and synonym matching
- **Answer normalisation** — case, punctuation, plurals, and synonyms are all handled
- **Hi/Lo bonus round** — optional per-game toggle
- **Family-friendly filter** — basic profanity check on names and answers
- **Host controls** — start game, kick players, adjust settings, play again
- **Sound effects** — generated with Web Audio API (no external files)
- **TV-optimized** host display with dramatic answer reveals
- **Mobile-optimized** player interface

## Game Settings (configurable in lobby)

| Setting | Default | Range |
|---------|---------|-------|
| Rounds | 6 | 3–10 |
| Answer time | 20 s | 10–30 s |
| Hi/Lo bonus | On | On / Off |
| Family filter | On | On / Off |

## Tech Stack

- **Backend:** Node.js + Express
- **Real-time:** Socket.IO
- **Frontend:** Vanilla HTML / CSS / JS (no build step)
- **Data:** JSON file (no database)
- **State:** In-memory (rooms are ephemeral)

## Network Play

Make sure all devices are on the same Wi-Fi network. The server binds to port **3000** by default (override with the `PORT` environment variable).

```bash
# Custom port
PORT=8080 npm start
```

## License

MIT
