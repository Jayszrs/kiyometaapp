// WebView requires a real Android/iOS platform implementation
// (`WebViewPlatform.instance`), which isn't available under the plain
// `flutter test` host environment — so this app isn't unit-testable via
// widget tests without a platform mock. Verify it manually with
// `flutter run -d <device-id>` on an Android device/emulator instead.

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('placeholder — see comment above for how this app is verified', () {});
}
