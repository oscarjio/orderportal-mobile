# OrderPortal Mobile

Mobilapp för tidskrivning mot Projektportalen, byggd som en webbapp (`www/`) och paketerad för Android med [Capacitor](https://capacitorjs.com/).

Desktopversionen finns i [orderportal](https://github.com/oscarjio/orderportal).

## Kom igång

Du behöver Node.js 18+ och Android Studio (med Android SDK).

```bash
npm install
npm run sync          # kopierar www/ till Android-projektet
npm run open:android  # öppnar projektet i Android Studio
```

## Bygga APK

```bash
npm run build:apk          # debug-APK
npm run build:apk-release  # release-APK (kräver signeringsnyckel)
```

Den färdiga debug-APK:n hamnar under `android/app/build/outputs/apk/debug/`.

## Struktur

- `www/` – själva appen (HTML, CSS, JS), inklusive Projektportalen-klient och HTTP Digest-autentisering
- `android/` – Capacitor-genererat Android-projekt
- `capacitor.config.json` – app-id, namn och tillåtna domäner
