# Local installation — v6 UX & Workflow

## Safe upgrade procedure
1. Stop the current application with `Ctrl+C` in its terminal.
2. In pgAdmin, create a backup of the current `nuclea_erp` database. Keep a copy of the current project, `.env`, and `private_uploads/` separately.
3. Extract this ZIP into a **new folder**. Do not replace your only working directory.
4. Copy the old `.env` into the new project folder and restore `private_uploads/` only from your own trusted backup. Never share `.env` or private documents.
5. Open a terminal in the new project root (the folder containing `package.json`) and run:

   ```powershell
   npm install
   npm test
   npm start
   ```

6. Visit `http://localhost:3000` and perform the UAT checklist in `UAT_CHECKLIST_V6.md` before adopting the build.

## Notes
- The application uses PostgreSQL plus Node.js/Express/EJS. Use the database name, host, user and password configured in `.env`.
- Do not run `npm audit fix --force` blindly; dependency upgrades can introduce breaking changes. Review audit findings and update dependencies intentionally.
- This source revision has not been migrated against your actual local database by the build process. Startup initialization can apply schema changes; therefore a backup and staging/UAT run are required first.
- Live GPS on a phone usually requires a secure browser context (HTTPS). `localhost` is treated specially only on the same device; opening an HTTP LAN IP address from a phone may not permit browser geolocation. Use a properly configured HTTPS environment for real driver trials. Background tracking can be suspended by mobile operating systems.
- Label pages are placeholders until the approved vial/leadpot artwork and print specifications are provided.

## Dependency and test note
Run `npm install` from the project root before `npm test`. The EJS template checker imports the `ejs` package, which is installed by that dependency step. In the source-build environment for this release, installing `ejs` was not possible because the package registry was unreachable; a separate static EJS JavaScript syntax scan and Node.js syntax checks were run. This is not a substitute for browser/UAT tests.
