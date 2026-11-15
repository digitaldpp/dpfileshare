# DP File Share

Share files straight from your Windows PC through private, expiring links. One exe, no
accounts, no cloud, no size limits: the files go directly from your PC to the person you send
the link to.

- **Send files or whole folders**, or **let someone send files to you**, or both on one link.
- **Links expire** when you choose (an hour to 30 days, a set date, or never), and you can
  extend, expire or delete them at any time.
- **Big files are fine.** Downloads can be resumed, and uploads go in pieces that retry on
  their own, so a dropped connection or closed laptop doesn't mean starting over.
- **Off until you need it.** It sits in the tray using almost nothing. Nothing is reachable
  from outside until you turn sharing on.

## Install

1. Download `DP File Share.exe` from the
   [latest release](https://github.com/digitaldpp/dpfileshare/releases/latest) and put it
   anywhere you like.
2. Run it. An icon appears in the tray (gray = off, green = on) and the share manager opens in
   your browser.
3. The first time sharing turns on, Windows may ask whether to allow it through the firewall.
   Choose **Allow**.
4. To be reachable from outside your home network, forward TCP port **53817** on your router
   to this PC. (Search for your router model plus "port forwarding".)

The exe isn't code-signed, so Windows SmartScreen may show "Windows protected your PC" the
first time. Click **More info**, then **Run anyway**. If you'd rather not trust a download,
[build it yourself](#build-from-source); it takes about a minute.

Nothing else needs installing. Windows 10 or 11, 64-bit.

## Use

- **Left-click the tray icon** to open the share manager. If sharing is off, this turns it on.
- In the share manager, pick what the link allows:
  - **They can download**: add files and folders from any drive. Folders can be browsed.
  - **They can upload**: they get a drop zone. Files are saved to a new folder in
    `Downloads\DP File Share`, or a folder you choose. Each link has an upload limit
    (10 GB unless you change it).
- Choose when the link expires, click **Create link**, and send the link to them.
- **Right-click the tray icon** to turn sharing on or off, start it with Windows, or exit.
  Turning off warns you first if a download or upload is in progress.

Links look like `https://<your address>:53817/s/<43 random characters>`. They only work
while sharing is on.

## Good to know

- **Browser warning.** The first time someone opens a link, their browser warns that the
  connection isn't private. That is because the app makes its own (self-signed) certificate.
  The connection is still encrypted. They click **Advanced**, then **Proceed**. To get rid of
  the warning, use a domain name and a real certificate (see [Settings](#settings)).
- **Your address can change.** Most home internet connections get a new public IP now and
  then. When that happens, links you already sent stop working; the share manager flags them
  and shows the new address. To avoid this, point a dynamic DNS name at your home and set it
  as `publicHost`.
- **Deleting a link never deletes files.** Unfinished uploads are cleaned up after 7 days, or
  when their link expires. Expired links stay listed for 30 days.

## Security

- A link is the only way in. Its token is 256 random bits, so it can't be guessed, and an
  address that tries 20 wrong links is blocked for 10 minutes.
- Someone with a link can reach only what is in that link. Paths that try to leave a shared
  folder, including through shortcuts and junctions, are refused.
- The share manager listens only on `127.0.0.1`. It can't be opened from another device, and
  it rejects requests that don't come from its own page.
- The app's own data (settings, links, the certificate's key) can't be shared, even if you
  share a folder that contains it.
- Anyone who gets hold of a link can use it until it expires, so send links privately and
  keep expiry times short.

See [SECURITY.md](SECURITY.md) for how to report a problem.

## Settings

Settings, links, the certificate and the log live in `%LOCALAPPDATA%\DP File Share`
(right-click the tray icon, then **Open settings and log folder**). To change a setting,
create `config.json` there, using [config.example.json](config.example.json) as a start, and
turn sharing off and on.

| Key                    | Meaning                                                         | Default |
|------------------------|-----------------------------------------------------------------|---------|
| `port`                 | Public HTTPS port that links use. Forward this one on the router. | 53817 |
| `adminPort`            | Share manager port, this PC only                                | 53818   |
| `uploadDir`            | Folder that holds uploads                                       | `Downloads\DP File Share` |
| `defaultUploadLimitGB` | Upload limit filled in for new links                            | 10      |
| `defaultExpiryHours`   | Expiry selected for new links                                   | 168 (7 days) |
| `publicHost`           | Name to use in links instead of the public IP, like `files.example.com` | none |
| `certFile` / `keyFile` | Your own TLS certificate and key (PEM)                          | self-signed, made on first start |

When `publicHost` is not set, the app looks up your public IP by asking api.ipify.org (or
icanhazip.com or checkip.amazonaws.com if that fails). It makes no other outside connections.

**Portable mode:** if a `config.json` (or `links.json`) sits in the same folder as the exe,
that folder is used for everything instead, and uploads go to `uploads` inside it.

**Uninstall:** untick **Start with Windows**, exit from the tray, then delete the exe and
`%LOCALAPPDATA%\DP File Share`.

## Build from source

You need Windows and [Node.js](https://nodejs.org) 20 or newer. The tray program is built with
the C# compiler that comes with Windows.

```
npm ci
npm test
npm run build
```

The result is `dist\DP File Share.exe`.

How it is put together:

- `server.js` is the whole server: plain Node.js with no dependencies. `public/` holds the
  share manager and the page recipients see.
- `tray/Tray.cs` is the tray program (C#, .NET Framework, which every supported Windows has).
- `build.ps1` packs the server and its pages into a copy of `node.exe` (a Node
  [single executable application](https://nodejs.org/api/single-executable-applications.html)),
  compresses that, and attaches it to the tray program. When sharing is turned on, the tray
  program unpacks it to `%LOCALAPPDATA%\DP File Share\engine` and runs it.

To work on the server without building, run `npm start` and open `http://127.0.0.1:53818`.
It keeps its data in the project folder.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
