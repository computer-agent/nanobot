# nanobot Desktop

Tracked Electron package for the Mac-first nanobot desktop app.

The desktop app reuses the root WebUI build at `nanobot/web/dist`; it does not
copy or fork the React source. Electron owns the local engine lifecycle, exposes
the `nanobot-app://` app protocol to the renderer, and proxies `/api/*` plus
`/webui/bootstrap` to a private loopback `nanobot desktop-gateway` process.

## Development

```sh
cd webui && npm run build
cd ../desktop && npm run build && npm run start
```

For source checkouts, the app uses `python3` by default and injects the repo
root into `PYTHONPATH`. Packaged builds look for a bundled interpreter at
`Resources/nanobot-engine/bin/python3`.

## Engine Bundle

Release builds should prepare `resources/nanobot-engine/` from a macOS
`python-build-standalone` archive before running `electron-builder`:

```sh
cd desktop
PYTHON_STANDALONE_TARBALL=/path/to/python-build-standalone.tar.zst \
  npm run prepare-engine
```

`PYTHON_STANDALONE_URL` can be used instead of a local tarball. Set
`NANOBOT_WHEELHOUSE=/path/to/wheels` to install nanobot from a locked wheelhouse
without reaching PyPI. The script installs `nanobot-ai[api]` into the bundled
runtime and writes `nanobot-engine.json` for diagnostics.

## Updating Desktop Builds

Desktop does not copy the WebUI source or fork the Python agent code. A release
bundle is assembled from the current repository state:

1. Build the shared WebUI:

   ```sh
   npm run build --prefix webui
   ```

   `electron-builder` packages the resulting `nanobot/web/dist` directory as
   `Resources/nanobot-webui`.

2. Prepare the bundled Python engine:

   ```sh
   cd desktop
   PYTHON_STANDALONE_TARBALL=/path/to/python-build-standalone.tar.zst \
     npm run prepare-engine
   ```

   The script installs the current checkout's `nanobot-ai[api]` package into
   `resources/nanobot-engine/`, so agent, provider, tool, WebSocket, and config
   changes flow into the next desktop build automatically.

3. Build the desktop app and DMG:

   ```sh
   npm run build
   npm run dist:mac:arm64
   npm run dist:mac:x64
   ```

User data is not stored in the app bundle. Config, sessions, logs, workspace
state, and the default workspace remain under the platform app data directory,
so updating the app replaces code without overwriting local user state.

## Runtime Contract

- User data lives under the platform app data directory (`~/Library/Application Support/nanobot/` on macOS).
- The gateway binds only to `127.0.0.1` on a random port and uses a transient secret.
- The gateway starts with only the WebSocket local channel enabled and does not serve the WebUI static bundle.
- The renderer loads assets through `nanobot-app://app/...`; browser users cannot open the desktop UI from the gateway port.
- WebSocket traffic still uses the short-lived token minted by `/webui/bootstrap`.

`nanobot-desktop/` remains an ignored prototype folder. Product code should live
here.
