# DP File Share

Share files on this PC through private, expiring links. No accounts, no passwords and no
dependencies, just Node.js 18+ and Windows.

## How it works

- **Tray icon.** `DP File Share.exe` sits in the tray and starts with Windows. On boot,
  sharing is **off**: the icon only draws itself and waits, so it costs nothing at startup.
  Gray icon means off, green means on.
  - Left-click the icon (or pick **Share files / create a link…**) to open the share manager.
    If sharing is off, this turns it on first.
  - **Turn on / Turn off**: turning off warns you if downloads or uploads are in progress.
  - **Start with Windows**: tick or untick it.
- **Share manager** (`http://127.0.0.1:53818`). It only listens on this PC and is never
  reachable from the network. Here you create links:
  - **They can download**: pick files and/or folders (any drive). Folders can be browsed.
  - **They can upload**: they get a drop zone. Files go to a new folder in `uploads`, or a
    folder you choose. There's an upload limit per link (default 10 GB, or no limit).
  - Tick both for a two-way link.
  - **Expiry**: 1 hour to 30 days, never, or a specific date. You can extend, expire or
    delete a link later. Deleting a link never deletes files.
- **Links** look like `https://<your public IP>:53817/s/<random 43-character token>`.
  The token can't be guessed. Nothing else on the server can be browsed. Every response tells
  search engines not to index it, and `robots.txt` disallows everything.

## Good to know

- **Dynamic IP.** The manager looks up your public IP (ipify, falling back to icanhazip and
  AWS). If it changes, links you already sent stop working. The manager flags affected
  links and shows the new address. To avoid this, point a (dynamic) DNS name at your
  home IP and set `publicHost` in `config.json`.
- **Certificate warning.** Recipients see a browser warning the first time, because the
  certificate is self-signed. With a domain you can use a real certificate (`certFile` / `keyFile`).
- **Big files.** Downloads support resuming (HTTP Range). Uploads go in 32 MB pieces and
  retry on their own. If the page is reloaded, re-adding the same file continues where it stopped.
- Unfinished uploads are cleaned up after 7 days, or when their link expires. Expired
  links stay listed for 30 days, then disappear.
- Activity is logged to `server.log` (overwritten on each start).

## Settings (`config.json`)

| Key                     | Meaning                                                   |
|-------------------------|-----------------------------------------------------------|
| `port`                  | Public HTTPS port for links (53817; forward it on the router) |
| `adminPort`             | Share manager port, this PC only (53818)                  |
| `uploadDir`             | Default parent folder for uploads                         |
| `defaultUploadLimitGB`  | Upload limit pre-filled for new links (10)                |
| `defaultExpiryHours`    | Expiry pre-selected for new links (168 = 7 days)          |
| `publicHost`            | Optional hostname to use in links instead of the public IP |
| `nodePath`              | Optional full path to `node.exe` if it isn't on PATH      |
| `certFile` / `keyFile`  | TLS certificate and key                                   |

## Setup

```
powershell -ExecutionPolicy Bypass -File install-startup.ps1
```

This builds the tray program if needed (`build-tray.ps1`, using the C# compiler that comes with
Windows), registers it to start with Windows, and starts it. To undo:
`install-startup.ps1 -Remove`.

You can still run the server without the tray: `npm start`.

Allow the public port through Windows Firewall (admin PowerShell), and forward TCP 53817 on the
router to this PC:

```
New-NetFirewallRule -DisplayName "DP File Share" -Direction Inbound -Protocol TCP -LocalPort 53817 -Action Allow
```
