# typed: strict
# frozen_string_literal: true

# MarioCode — Homebrew cask
#
# Distributes the GitHub Release DMGs (MarioCode-X.Y.Z-arm64.dmg / MarioCode-X.Y.Z.dmg)
# without the Gatekeeper "unverified developer" warning: brew strips the
# com.apple.quarantine attribute, so no first-launch right-click > Open dance.
#
# Where it lives:
#   - Self-hosted tap (recommended): put this file at `Casks/mariocode.rb` in a
#     new repo named `maxiaopang123/homebrew-mariocode`, then:
#         brew tap maxiaopang123/mariocode
#         brew install --cask mariocode
#   - Official homebrew-cask: the same content goes to `Casks/m/mariocode.rb`
#     in a PR to github.com/Homebrew/homebrew-cask.
#
# Per release, bump `version` + both `sha256` values (see README or the repo
# release notes for the one-liner that refreshes them):
#   curl -sL -o /tmp/m.dmg <dmg-url> && shasum -a 256 /tmp/m.dmg
#
# NOTE: do NOT set `auto_updates true` — MarioCode's electron-updater can't verify
# its ad-hoc signature, so brew is the actual update channel on macOS.
#
# ⚠️ version / sha256 below are placeholders until MarioCode publishes its
# first Release — refresh them before publishing the tap.

cask "mariocode" do
  version "0.1.13"

  on_arm do
    sha256 "e3a409da8eb6a51addfb316386f8c2e96d70d48288b0ceeaac5a52128a75d12a"

    url "https://github.com/maxiaopang123/MarioCode/releases/download/v#{version}/MarioCode-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "c901fcd43629b89ec921bd079504daebcf74d9be5edb2765facde14139f82740"

    url "https://github.com/maxiaopang123/MarioCode/releases/download/v#{version}/MarioCode-#{version}.dmg"
  end

  name "MarioCode"
  desc "Desktop GUI for the Claude Agent SDK"
  homepage "https://github.com/maxiaopang123/MarioCode"

  app "MarioCode.app"

  # Packaged builds pin userData to `~/Library/Application Support/MarioCode`
  # (see apps/desktop/src/main/index.ts). Contains the session DB
  # (claude-gui.db) + logs. `~/.mariocode` holds the engine config roots.
  zap trash: [
    "~/Library/Application Support/MarioCode",
    "~/Library/Preferences/com.mariocode.desktop.plist",
    "~/Library/Saved Application State/com.mariocode.desktop.savedState",
    "~/.mariocode",
  ]
end
