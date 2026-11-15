# Contributing

Thanks for helping. A few things keep this project easy to trust and easy to run:

- **No runtime dependencies.** `server.js` uses only what comes with Node.js, and the tray
  program only what comes with Windows. Please keep it that way.
- **Run the tests** before opening a pull request: `npm test`. They start the real server on
  spare ports with a throwaway folder. If you change behaviour, add or update a test in
  `test/e2e.test.js`.
- **Test the built app** when you touch `tray/Tray.cs` or `build.ps1`: `npm run build`, then
  run `dist\DP File Share.exe`. To test the packed server on its own:
  `set DPFS_ENGINE=build\dpfs-engine.exe` and `npm test`.
- **Wording.** Messages are read by people who aren't technical. Say what happened and what
  to do next, in plain words.

For security problems, see [SECURITY.md](SECURITY.md) instead of opening an issue.

By contributing you agree that your work is released under the [MIT License](LICENSE).
