# JitsFlow for iPhone (and Android)

The App Store app is the web app at https://www.jitsflow.com/app/ in a native shell (Capacitor), so every website
deploy updates the app too. Native extras: the phone's contacts (coaches add students by ticking them).

- `capacitor.config.json`: app id `com.jitsflow.app`, loads the live site.
- `ios/`: the Xcode project (Swift Package Manager; no CocoaPods).
- Builds run on GitHub's Macs: `.github/workflows/ios-testflight.yml` uploads each build to TestFlight.

Repository secrets the build needs: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
Before the first upload, create the app in App Store Connect (My Apps → + → New App) with bundle ID `com.jitsflow.app`.

## Android

- `android/`: the Gradle project (app id `com.jitsflow.app`, contacts permission, brand icons and splash).
- `.github/workflows/android.yml` builds a test APK on every change (download it from the run's artifacts),
  a signed Play Store bundle when `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` are set, and uploads it
  to Play's internal testing track when `PLAY_SERVICE_ACCOUNT_JSON` is set too.
- Build locally: `npx cap sync android && cd android && ./gradlew assembleDebug` (needs JDK 21 and the Android SDK).
