# JitsFlow for iPhone (and Android)

The App Store app is the web app at https://www.jitsflow.com/app/ in a native shell (Capacitor), so every website
deploy updates the app too. Native extras: the phone's contacts (coaches add students by ticking them).

- `capacitor.config.json`: app id `com.jitsflow.app`, loads the live site.
- `ios/`: the Xcode project (Swift Package Manager; no CocoaPods).
- Builds run on GitHub's Macs: `.github/workflows/ios-testflight.yml` uploads each build to TestFlight.

Repository secrets the build needs: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
Before the first upload, create the app in App Store Connect (My Apps → + → New App) with bundle ID `com.jitsflow.app`.
