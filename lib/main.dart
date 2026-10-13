import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

// The tablet runner maps this emulator-local port to the Vite server on the
// development PC with `adb reverse`, so this URL does not depend on Wi-Fi IPs.
// Build a production APK with:
//   flutter build apk --release --dart-define=APP_URL=https://...your-host.../
const String kServerUrl =
    String.fromEnvironment('APP_URL', defaultValue: 'http://127.0.0.1:5173');

void main() {
  runApp(const KiyometaApp());
}

class KiyometaApp extends StatelessWidget {
  const KiyometaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kiyometa Order Management',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF1A3458),
        useMaterial3: true,
      ),
      home: const WebViewHome(),
    );
  }
}

class WebViewHome extends StatefulWidget {
  const WebViewHome({super.key});

  @override
  State<WebViewHome> createState() => _WebViewHomeState();
}

class _WebViewHomeState extends State<WebViewHome> {
  late final WebViewController _controller;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) => setState(() {
            _loading = true;
            _error = null;
          }),
          onPageFinished: (_) => setState(() => _loading = false),
          onWebResourceError: (error) => setState(() {
            _loading = false;
            _error =
                'Failed to load $kServerUrl\n(${error.description})\n\n'
                'Run the app through option 4 so the project runner can start '
                'the web server and connect it to the Android emulator.';
          }),
        ),
      );

    // Android WebView has no built-in <input type="file"> handler. Without this
    // the "Upload document" and "Take photo" buttons in the quotation scan do
    // nothing. Other platforms (web/Windows) let the host browser handle it.
    final platform = controller.platform;
    if (!kIsWeb && platform is AndroidWebViewController) {
      // File inputs are opened from a file:// URI for the camera. WebView blocks
      // file:// access by default when targeting API 30+.
      platform.setAllowFileAccess(true);
      platform.setAllowContentAccess(true);
      platform.setOnShowFileSelector(_handleFileSelector);
    }

    controller.loadRequest(Uri.parse(kServerUrl));
    _controller = controller;
  }

  Future<List<String>> _handleFileSelector(FileSelectorParams params) async {
    try {
      if (params.isCaptureEnabled) {
        final XFile? shot = await ImagePicker().pickImage(
          source: ImageSource.camera,
          imageQuality: 90,
        );
        return shot == null ? const <String>[] : <String>[Uri.file(shot.path).toString()];
      }

      final extensions = _extensionsFor(params.acceptTypes);
      if (params.mode == FileSelectorMode.openMultiple) {
        final files = await FilePicker.pickFiles(
          type: extensions == null ? FileType.any : FileType.custom,
          allowedExtensions: extensions,
        );
        return files.map((file) => file.uri.toString()).toList();
      }

      final file = await FilePicker.pickFile(
        type: extensions == null ? FileType.any : FileType.custom,
        allowedExtensions: extensions,
      );
      return file == null ? const <String>[] : <String>[file.uri.toString()];
    } catch (_) {
      return const <String>[];
    }
  }

  List<String>? _extensionsFor(List<String> acceptTypes) {
    if (acceptTypes.isEmpty || acceptTypes.contains('*/*')) {
      return null;
    }

    final extensions = <String>{};
    for (final type in acceptTypes) {
      final value = type.toLowerCase();
      if (value == 'application/pdf' || value == '.pdf') {
        extensions.add('pdf');
      } else if (value.startsWith('image/')) {
        extensions.addAll(const ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']);
      } else if (value == 'application/msword') {
        extensions.add('doc');
      } else if (value ==
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        extensions.add('docx');
      }
    }

    return extensions.isEmpty ? null : extensions.toList();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    await _controller.reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            if (_error == null) WebViewWidget(controller: _controller),
            if (_loading && _error == null)
              const Center(child: CircularProgressIndicator()),
            if (_error != null)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: Image.asset(
                          'assets/branding/kiyometa-logo.png',
                          width: 72,
                          height: 72,
                          fit: BoxFit.cover,
                        ),
                      ),
                      const SizedBox(height: 12),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 520),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _reload,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
