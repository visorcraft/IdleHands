# Publishing / Distribution

Idle Hands can be distributed two ways:

1. **npm (recommended)** via Trusted Publishing (OIDC)
2. **GitHub Release tarball** (`.tgz`) fallback

---

## Option A (Recommended): npm Trusted Publishing

This repo is configured for npm Trusted Publishing via GitHub Actions.

Workflow: `.github/workflows/publish-npm.yml`

### Why this model

- No long-lived npm automation token stored in GitHub secrets
- No bypass-2FA token needed
- npm can verify provenance (`--provenance`)

### One-time npm setup

In npm package settings (for `idlehands`):

1. Add a **Trusted Publisher**
2. Provider: **GitHub Actions**
3. Repository: `visorcraft/idlehands`
4. Workflow file: `publish-npm.yml`
5. (Optional) Restrict to tags/branch/environment according to your policy

> Note: npm UI may call this “Trusted publishing” and “Add publisher”.

### Release flow (npm)

From a clean working tree:

```bash
npm test
npm version X.Y.Z

git push origin main
git push origin vX.Y.Z
```

Pushing the `vX.Y.Z` tag triggers:

- build
- tests
- `npm publish --access public --provenance`

Install after publish:

```bash
npm i -g idlehands
idlehands --help
```

---

## Option B: GitHub Release tarball (fallback)

Useful when npm publish is unavailable.

### Install latest release artifact

```bash
TAG=$(gh release view --repo visorcraft/idlehands --json tagName -q .tagName)
VER=${TAG#v}
npm i -g "https://github.com/visorcraft/idlehands/releases/download/${TAG}/idlehands-${VER}.tgz"
idlehands --help
```

### Release procedure (tarball)

```bash
npm test
rm -f idlehands-*.tgz
npm pack
sha256sum idlehands-*.tgz

git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z

gh release create vX.Y.Z idlehands-X.Y.Z.tgz \
  --title "vX.Y.Z" \
  --notes "Install:\n  npm i -g https://github.com/visorcraft/idlehands/releases/download/vX.Y.Z/idlehands-X.Y.Z.tgz\n\nsha256: <paste>"
```

---

## Notes

- `npm pack` runs `prepack`, which rebuilds `dist/`.
- Package metadata is in `package.json` (`name`, `bin`, `files`, `repository`, etc.).
- If switching to scoped publishing later, update `name` and install docs accordingly.
