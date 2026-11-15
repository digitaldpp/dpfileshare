# Security

DP File Share opens a port on a home PC to the internet, so security problems matter here.

## Reporting a problem

Please don't open a public issue for a vulnerability. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/digitaldpp/dpfileshare/security/advisories/new).
Include what you did, what happened, and the version (right-click the tray icon; it is in the
**About** line).

Only the latest release gets fixes.

## What the app is meant to guarantee

- Without a valid, unexpired link, the public port gives out nothing but `robots.txt` and the
  page's own stylesheet and script.
- A link gives access only to the files and folders in that link, and only in the directions
  (download, upload) it was created with.
- Uploads can only create new files inside that link's upload folder. They never overwrite a
  file and never write anywhere else.
- The share manager can't be reached from another device, or driven by another website open
  in your browser.

Anything that breaks one of these is a vulnerability.

## What it does not protect against

- Someone who has the link. A link is a password; anyone it is forwarded to can use it.
- Other programs or users on the same PC. They can reach the share manager on `127.0.0.1`.
- The certificate is self-signed by default, so recipients can't verify they reached your PC
  and not someone in between. Use your own domain and certificate if that matters to you.
