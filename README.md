# Obsidian OneDrive Sync

[![CI](https://github.com/jeffsteinbok/obsidian-onedrive/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffsteinbok/obsidian-onedrive/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-purple)](https://obsidian.md)

![Social Preview](socialPreview.png)

Sync your Obsidian vault with **OneDrive Personal** accounts. Zero-config, mobile-friendly, battery-efficient.

## ✨ Features

- **Zero-Configuration** — No Azure AD app registration. Just click connect and authenticate.
- **Mobile-First** — Device Code Flow works on iOS and Android with no redirects.
- **Event-Driven Sync** — Syncs on file changes, not polling. Great for battery life.
- **Bidirectional** — Automatic two-way sync with configurable conflict resolution.
- **Two Access Modes** — App Folder (secure, isolated) or Full Access (shareable, flexible location).

## 🚀 Installation

### Via BRAT (Recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. BRAT settings → **Add Beta Plugin** → `JeffSteinbok/obsidian-onedrive`

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/JeffSteinbok/obsidian-onedrive/releases)
2. Place them in `.obsidian/plugins/obsidian-onedrive/`
3. Enable the plugin in Settings → Community Plugins

## 🔧 Setup

1. Settings → OneDrive Sync → **Connect to OneDrive**
2. Enter the displayed code at [microsoft.com/devicelogin](https://microsoft.com/devicelogin)
3. Sign in and grant permissions
4. Done — your vault syncs automatically!
