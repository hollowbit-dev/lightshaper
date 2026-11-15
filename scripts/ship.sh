#!/bin/bash
# Run it yourself to publish a new Lightshaper version: bash ~/Desktop/Lightshaper/scripts/ship.sh
# 1. GitHub release (builds the installers). 2. hollowbit.dev picks up the new version. 3. Homebrew cask.
set -e
D="$HOME/Desktop"
AUTHOR=(-c user.name="Elvis Zygmanta" -c user.email="hollowbit-dev@users.noreply.github.com")
cd "$D/Lightshaper"
V=$(node -p "require('./package.json').version")
if gh release view "v$V" --repo hollowbit-dev/lightshaper >/dev/null 2>&1; then echo "v$V is already released"; else bash scripts/release.sh; fi

echo "== hollowbit.dev"
cd "$D/Hollowbit"
GITHUB_TOKEN=$(gh auth token) node site/build.mjs
git add -A; git "${AUTHOR[@]}" commit -qm "Lightshaper $V" || echo "(no changes)"
git push -q

echo "== Homebrew cask"
cd "$D/Hollowbit-listings/homebrew-tap"
A=$(shasum -a 256 "$D/Lightshaper/dist/Lightshaper-$V-mac-arm64.dmg" | cut -d' ' -f1)
I=$(shasum -a 256 "$D/Lightshaper/dist/Lightshaper-$V-mac-x64.dmg" | cut -d' ' -f1)
sed -i '' -E "s/version \"[0-9.]+\"/version \"$V\"/; s/arm:   \"[0-9a-f]{64}\"/arm:   \"$A\"/; s/intel: \"[0-9a-f]{64}\"/intel: \"$I\"/" Casks/lightshaper.rb
git add Casks/lightshaper.rb; git "${AUTHOR[@]}" commit -qm "lightshaper $V" || echo "(cask unchanged)"
git push -q origin HEAD:main
echo "Done: Lightshaper $V is out."
